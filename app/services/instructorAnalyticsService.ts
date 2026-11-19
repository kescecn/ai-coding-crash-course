import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
} from "~/db/schema";

// ─── Instructor Analytics Service ───
// Computes dashboard figures for an instructor with grouped queries across
// all of their courses (no per-course queries).

export type RangePreset = "7d" | "30d" | "12m" | "all";

// Completion: a student is complete in a course when they have completed
// every lesson. Rate = complete students / enrolled students; null when the
// course has no students or no lessons. The pooled rate sums across courses.
function getCompletionStats(courseIds: number[], lessonCounts: Map<number, number>) {
  const enrolled = db
    .selectDistinct({ courseId: enrollments.courseId, userId: enrollments.userId })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
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
    return { summary: { students: 0, earnings: 0, completionRate: null as number | null }, courses: [] };
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

  const completion = getCompletionStats(courseIds, lessonsByCourse);

  const courseEntries = instructorCourses.map((course) => ({
    ...course,
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
    },
    courses: courseEntries,
  };
}
