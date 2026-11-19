import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  quizAttempts,
  quizzes,
} from "~/db/schema";

// ─── Instructor Analytics Service ───
// Per-course and total student/earnings figures for an instructor's dashboard.
// Uses positional parameters (project convention).

export type AnalyticsRange = "all";

export type QuizAnalytics = {
  quizId: number;
  title: string;
  // Students with at least one attempt.
  students: number;
  // Both use each student's best attempt. Score is 0–1, null with no attempts.
  averageScore: number | null;
  passRate: number | null;
};

export type CourseAnalytics = {
  courseId: number;
  students: number;
  earnings: number;
  // Share of enrolled students who completed every lesson, 0–1. Null when
  // there are no students or no lessons ("No data yet").
  completionRate: number | null;
  // Mean of each student's best score per quiz, 0–1. Null with no attempts.
  averageQuizScore: number | null;
  quizzes: QuizAnalytics[];
};

export type InstructorAnalytics = {
  totalStudents: number;
  totalEarnings: number;
  // Pooled across all enrollments, not an average of course rates.
  completionRate: number | null;
  // Pooled across every best attempt, not an average of course averages.
  averageQuizScore: number | null;
  courses: CourseAnalytics[];
};

// `now` is part of the signature so date-bounded ranges can slot in later;
// the "all" range ignores it.
export function getInstructorAnalytics(
  instructorId: number,
  range: AnalyticsRange,
  now: Date = new Date()
): InstructorAnalytics {
  void range;
  void now;

  const owned = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .orderBy(courses.id)
    .all();

  if (owned.length === 0) {
    return { totalStudents: 0, totalEarnings: 0, completionRate: null, averageQuizScore: null, courses: [] };
  }

  const courseIds = owned.map((c) => c.id);

  const studentRows = db
    .select({
      courseId: enrollments.courseId,
      students: sql<number>`count(distinct ${enrollments.userId})`,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId)
    .all();

  const earningsRows = db
    .select({
      courseId: purchases.courseId,
      earnings: sql<number>`sum(${purchases.pricePaid})`,
    })
    .from(purchases)
    .where(inArray(purchases.courseId, courseIds))
    .groupBy(purchases.courseId)
    .all();

  const totalStudents =
    db
      .select({ n: sql<number>`count(distinct ${enrollments.userId})` })
      .from(enrollments)
      .where(inArray(enrollments.courseId, courseIds))
      .get()?.n ?? 0;

  const studentsByCourse = new Map(studentRows.map((r) => [r.courseId, r.students]));
  const earningsByCourse = new Map(earningsRows.map((r) => [r.courseId, r.earnings]));

  const completion = getCompletionCounts(courseIds);
  const quizStats = getQuizStats(courseIds);

  const perCourse = courseIds.map((courseId) => {
    const counts = completion.get(courseId);
    return {
      courseId,
      students: studentsByCourse.get(courseId) ?? 0,
      earnings: earningsByCourse.get(courseId) ?? 0,
      completionRate: rate(counts?.completed ?? 0, counts?.enrolled ?? 0),
      averageQuizScore: quizStats.get(courseId)?.average ?? null,
      quizzes: quizStats.get(courseId)?.quizzes ?? [],
    };
  });

  const pooled = [...completion.values()].reduce(
    (sum, c) => ({
      completed: sum.completed + c.completed,
      enrolled: sum.enrolled + c.enrolled,
    }),
    { completed: 0, enrolled: 0 }
  );

  return {
    totalStudents,
    totalEarnings: perCourse.reduce((sum, c) => sum + c.earnings, 0),
    completionRate: rate(pooled.completed, pooled.enrolled),
    averageQuizScore: mean(
      [...quizStats.values()].flatMap((c) => c.bestScores)
    ),
    courses: perCourse,
  };
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

// Per course: distinct enrolled students and how many of them completed every
// lesson. Courses with no lessons are left out — nobody can complete them.
function getCompletionCounts(courseIds: number[]) {
  const lessonCounts = new Map(
    db
      .select({
        courseId: modules.courseId,
        lessons: sql<number>`count(*)`,
      })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(inArray(modules.courseId, courseIds))
      .groupBy(modules.courseId)
      .all()
      .map((r) => [r.courseId, r.lessons])
  );

  const completedCounts = new Map(
    db
      .select({
        courseId: modules.courseId,
        userId: lessonProgress.userId,
        done: sql<number>`count(distinct ${lessons.id})`,
      })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(
        and(
          inArray(modules.courseId, courseIds),
          eq(lessonProgress.status, LessonProgressStatus.Completed)
        )
      )
      .groupBy(modules.courseId, lessonProgress.userId)
      .all()
      .map((r) => [`${r.courseId}:${r.userId}`, r.done])
  );

  const students = db
    .selectDistinct({
      courseId: enrollments.courseId,
      userId: enrollments.userId,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .all();

  const result = new Map<number, { enrolled: number; completed: number }>();
  for (const { courseId, userId } of students) {
    const total = lessonCounts.get(courseId) ?? 0;
    if (total === 0) continue;
    const entry = result.get(courseId) ?? { enrolled: 0, completed: 0 };
    entry.enrolled += 1;
    if ((completedCounts.get(`${courseId}:${userId}`) ?? 0) >= total) {
      entry.completed += 1;
    }
    result.set(courseId, entry);
  }
  return result;
}

// Per course: its quizzes with per-quiz rows, plus every best score so course
// and overall averages can be pooled. A student's best attempt per quiz is the
// only one that counts, so a retake never drags the average down.
function getQuizStats(courseIds: number[]) {
  const quizRows = db
    .select({
      courseId: modules.courseId,
      quizId: quizzes.id,
      title: quizzes.title,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .orderBy(quizzes.id)
    .all();

  const attempts = db
    .select({
      quizId: quizAttempts.quizId,
      userId: quizAttempts.userId,
      score: quizAttempts.score,
      passed: quizAttempts.passed,
    })
    .from(quizAttempts)
    .where(
      inArray(
        quizAttempts.quizId,
        quizRows.map((q) => q.quizId)
      )
    )
    .all();

  const best = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) {
    const key = `${a.quizId}:${a.userId}`;
    const current = best.get(key);
    if (!current || a.score > current.score) best.set(key, a);
  }

  const result = new Map<
    number,
    { quizzes: QuizAnalytics[]; bestScores: number[]; average: number | null }
  >();
  for (const { courseId, quizId, title } of quizRows) {
    const entry = result.get(courseId) ?? {
      quizzes: [],
      bestScores: [],
      average: null,
    };
    const bests = [...best.values()].filter((a) => a.quizId === quizId);
    entry.quizzes.push({
      quizId,
      title,
      students: bests.length,
      averageScore: mean(bests.map((a) => a.score)),
      passRate: rate(bests.filter((a) => a.passed).length, bests.length),
    });
    entry.bestScores.push(...bests.map((a) => a.score));
    entry.average = mean(entry.bestScores);
    result.set(courseId, entry);
  }
  return result;
}
