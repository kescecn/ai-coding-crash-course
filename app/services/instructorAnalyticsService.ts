import { eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, lessons, modules, purchases } from "~/db/schema";

// ─── Instructor Analytics Service ───
// Computes dashboard figures for an instructor with grouped queries across
// all of their courses (no per-course queries).

export type RangePreset = "7d" | "30d" | "12m" | "all";

export function getInstructorAnalytics(
  instructorId: number,
  _range: RangePreset = "all",
  _now: Date = new Date()
) {
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
    return { summary: { students: 0, earnings: 0 }, courses: [] };
  }

  const courseIds = instructorCourses.map((c) => c.id);

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
      earnings: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .where(inArray(purchases.courseId, courseIds))
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
    .where(inArray(enrollments.courseId, courseIds))
    .get();

  const studentsByCourse = new Map(studentRows.map((r) => [r.courseId, r.students]));
  const lessonsByCourse = new Map(lessonRows.map((r) => [r.courseId, r.lessons]));
  const earningsByCourse = new Map(earningsRows.map((r) => [r.courseId, r.earnings]));

  const courseEntries = instructorCourses.map((course) => ({
    ...course,
    students: studentsByCourse.get(course.id) ?? 0,
    lessonCount: lessonsByCourse.get(course.id) ?? 0,
    earnings: earningsByCourse.get(course.id) ?? 0,
  }));

  return {
    summary: {
      students: totalStudents?.students ?? 0,
      earnings: courseEntries.reduce((sum, c) => sum + c.earnings, 0),
    },
    courses: courseEntries,
  };
}
