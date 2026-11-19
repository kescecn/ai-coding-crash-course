import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
} from "~/db/schema";

// ─── Instructor Analytics Service ───
// Computes dashboard figures for an instructor with grouped queries across
// all of their courses (no per-course queries).

export type RangePreset = "7d" | "30d" | "12m" | "all";

export const RANGE_PRESETS: RangePreset[] = ["7d", "30d", "12m", "all"];

// Parses a URL search param; anything unrecognised falls back to all time.
export function parseRangePreset(value: string | null | undefined): RangePreset {
  return RANGE_PRESETS.find((p) => p === value) ?? "all";
}

// ISO start of the window relative to `now`, or null for all time.
export function getRangeStart(range: RangePreset, now: Date): string | null {
  const start = new Date(now);
  switch (range) {
    case "7d":
      start.setUTCDate(start.getUTCDate() - 7);
      return start.toISOString();
    case "30d":
      start.setUTCDate(start.getUTCDate() - 30);
      return start.toISOString();
    case "12m":
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      return start.toISOString();
    case "all":
      return null;
  }
}

// Completion: a student is complete in a course when they have completed
// every lesson. Rate = complete students / enrolled students; null when the
// course has no students or no lessons. The pooled rate sums across courses.
function getCompletionStats(
  courseIds: number[],
  lessonCounts: Map<number, number>,
  since: string | null
) {
  const enrolled = db
    .selectDistinct({ courseId: enrollments.courseId, userId: enrollments.userId })
    .from(enrollments)
    .where(
      and(
        inArray(enrollments.courseId, courseIds),
        since ? gte(enrollments.enrolledAt, since) : undefined
      )
    )
    .all();

  const completedRows = db
    .select({
      courseId: modules.courseId,
      userId: lessonProgress.userId,
      completed: sql<number>`count(distinct ${lessonProgress.lessonId})`,
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
    .all();
  const completedByKey = new Map(
    completedRows.map((r) => [`${r.courseId}:${r.userId}`, r.completed])
  );

  const stats = new Map<number, { enrolled: number; complete: number }>();
  for (const { courseId, userId } of enrolled) {
    const total = lessonCounts.get(courseId) ?? 0;
    if (total === 0) continue;
    const entry = stats.get(courseId) ?? { enrolled: 0, complete: 0 };
    entry.enrolled += 1;
    if ((completedByKey.get(`${courseId}:${userId}`) ?? 0) >= total) {
      entry.complete += 1;
    }
    stats.set(courseId, entry);
  }

  let pooledEnrolled = 0;
  let pooledComplete = 0;
  const rates = new Map<number, number | null>();
  for (const id of courseIds) {
    const e = stats.get(id);
    rates.set(id, e ? e.complete / e.enrolled : null);
    if (e) {
      pooledEnrolled += e.enrolled;
      pooledComplete += e.complete;
    }
  }
  return {
    rates,
    overall: pooledEnrolled === 0 ? null : pooledComplete / pooledEnrolled,
  };
}

export type QuizRow = {
  quizId: number;
  title: string;
  students: number;
  avgScore: number | null;
  passRate: number | null;
};

const average = (xs: number[]) =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

// Per-quiz rows by course, plus course and overall averages. Scores are
// fractions (0–1) of each student's best attempt per quiz.
function getQuizPerformance(courseIds: number[], since: string | null) {
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

  const bestAttempts = db
    .select({
      quizId: quizAttempts.quizId,
      score: sql<number>`max(${quizAttempts.score})`,
      passed: sql<number>`max(${quizAttempts.passed})`,
    })
    .from(quizAttempts)
    .where(
      and(
        inArray(
          quizAttempts.quizId,
          quizRows.map((q) => q.quizId)
        ),
        since ? gte(quizAttempts.attemptedAt, since) : undefined
      )
    )
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .all();

  const attemptsByQuiz = new Map<number, typeof bestAttempts>();
  for (const a of bestAttempts) {
    attemptsByQuiz.set(a.quizId, [...(attemptsByQuiz.get(a.quizId) ?? []), a]);
  }

  const quizzesByCourse = new Map<number, QuizRow[]>();
  const scoresByCourse = new Map<number, number[]>();
  for (const q of quizRows) {
    const attempts = attemptsByQuiz.get(q.quizId) ?? [];
    const row: QuizRow = {
      quizId: q.quizId,
      title: q.title,
      students: attempts.length,
      avgScore: average(attempts.map((a) => a.score)),
      passRate: average(attempts.map((a) => (a.passed ? 1 : 0))),
    };
    quizzesByCourse.set(q.courseId, [...(quizzesByCourse.get(q.courseId) ?? []), row]);
    scoresByCourse.set(q.courseId, [
      ...(scoresByCourse.get(q.courseId) ?? []),
      ...attempts.map((a) => a.score),
    ]);
  }

  return {
    quizzesByCourse,
    avgScoreByCourse: new Map(
      [...scoresByCourse].map(([id, xs]) => [id, average(xs)])
    ),
    overallAvgScore: average([...scoresByCourse.values()].flat()),
  };
}

export function getInstructorAnalytics(
  instructorId: number,
  range: RangePreset = "all",
  now: Date = new Date()
) {
  const since = getRangeStart(range, now);
  const instructorCourses = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      description: courses.description,
      status: courses.status,
      coverImageUrl: courses.coverImageUrl,
    })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .all();

  if (instructorCourses.length === 0) {
    return {
      summary: {
        students: 0,
        earnings: 0,
        completionRate: null as number | null,
        avgQuizScore: null as number | null,
      },
      courses: [],
    };
  }

  const courseIds = instructorCourses.map((c) => c.id);

  const studentRows = db
    .select({
      courseId: enrollments.courseId,
      students: sql<number>`count(distinct ${enrollments.userId})`,
    })
    .from(enrollments)
    .where(
      and(
        inArray(enrollments.courseId, courseIds),
        since ? gte(enrollments.enrolledAt, since) : undefined
      )
    )
    .groupBy(enrollments.courseId)
    .all();

  const earningsRows = db
    .select({
      courseId: purchases.courseId,
      earnings: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .where(
      and(
        inArray(purchases.courseId, courseIds),
        since ? gte(purchases.createdAt, since) : undefined
      )
    )
    .groupBy(purchases.courseId)
    .all();

  const lessonRows = db
    .select({
      courseId: modules.courseId,
      lessons: sql<number>`count(${lessons.id})`,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .groupBy(modules.courseId)
    .all();

  const totalStudents = db
    .select({
      students: sql<number>`count(distinct ${enrollments.userId})`,
    })
    .from(enrollments)
    .where(
      and(
        inArray(enrollments.courseId, courseIds),
        since ? gte(enrollments.enrolledAt, since) : undefined
      )
    )
    .get();

  const studentsByCourse = new Map(studentRows.map((r) => [r.courseId, r.students]));
  const lessonsByCourse = new Map(lessonRows.map((r) => [r.courseId, r.lessons]));
  const earningsByCourse = new Map(earningsRows.map((r) => [r.courseId, r.earnings]));

  const completion = getCompletionStats(courseIds, lessonsByCourse, since);
  const quizPerformance = getQuizPerformance(courseIds, since);

  const courseEntries = instructorCourses.map((course) => ({
    ...course,
    quizzes: quizPerformance.quizzesByCourse.get(course.id) ?? [],
    avgQuizScore: quizPerformance.avgScoreByCourse.get(course.id) ?? null,
    students: studentsByCourse.get(course.id) ?? 0,
    lessonCount: lessonsByCourse.get(course.id) ?? 0,
    earnings: earningsByCourse.get(course.id) ?? 0,
    completionRate: completion.rates.get(course.id) ?? null,
  }));

  return {
    summary: {
      students: totalStudents?.students ?? 0,
      earnings: courseEntries.reduce((sum, c) => sum + c.earnings, 0),
      completionRate: completion.overall,
      avgQuizScore: quizPerformance.overallAvgScore,
    },
    courses: courseEntries,
  };
}
