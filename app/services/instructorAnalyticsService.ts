import { eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, purchases } from "~/db/schema";

// ─── Instructor Analytics Service ───
// Per-course and total student/earnings figures for an instructor's dashboard.
// Uses positional parameters (project convention).

export type AnalyticsRange = "all";

export type CourseAnalytics = {
  courseId: number;
  students: number;
  earnings: number;
};

export type InstructorAnalytics = {
  totalStudents: number;
  totalEarnings: number;
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
    return { totalStudents: 0, totalEarnings: 0, courses: [] };
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

  const perCourse = courseIds.map((courseId) => ({
    courseId,
    students: studentsByCourse.get(courseId) ?? 0,
    earnings: earningsByCourse.get(courseId) ?? 0,
  }));

  return {
    totalStudents,
    totalEarnings: perCourse.reduce((sum, c) => sum + c.earnings, 0),
    courses: perCourse,
  };
}
