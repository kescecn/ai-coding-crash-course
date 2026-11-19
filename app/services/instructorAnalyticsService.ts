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
} from "~/db/schema";

// ─── Instructor Analytics Service ───
// Per-course and total student/earnings figures for an instructor's dashboard.
// Uses positional parameters (project convention).

export type AnalyticsRange = "all";

export type CourseAnalytics = {
  courseId: number;
  students: number;
  earnings: number;
  // Share of enrolled students who completed every lesson, 0–1. Null when
  // there are no students or no lessons ("No data yet").
  completionRate: number | null;
};

export type InstructorAnalytics = {
  totalStudents: number;
  totalEarnings: number;
  // Pooled across all enrollments, not an average of course rates.
  completionRate: number | null;
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
    return { totalStudents: 0, totalEarnings: 0, completionRate: null, courses: [] };
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

  const perCourse = courseIds.map((courseId) => {
    const counts = completion.get(courseId);
    return {
      courseId,
      students: studentsByCourse.get(courseId) ?? 0,
      earnings: earningsByCourse.get(courseId) ?? 0,
      completionRate: rate(counts?.completed ?? 0, counts?.enrolled ?? 0),
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
    courses: perCourse,
  };
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
