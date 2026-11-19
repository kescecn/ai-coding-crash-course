import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getInstructorAnalytics } from "./instructorAnalyticsService";

function addStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function addCourse(
  instructorId: number,
  slug: string,
  status = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "d",
      salesCopy: "s",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

function purchase(userId: number, courseId: number, amountPaid: number) {
  testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid })
    .run();
}

describe("getInstructorAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("counts a student once per course despite duplicate enrollments", () => {
    const a = addStudent("a@x.com");
    enroll(a.id, base.course.id);
    enroll(a.id, base.course.id);
    enroll(base.user.id, base.course.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses[0].students).toBe(2);
    expect(result.summary.students).toBe(2);
  });

  it("counts a student in several courses once in the headline total", () => {
    const second = addCourse(base.instructor.id, "second");
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, second.id);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => c.students)).toEqual([1, 1]);
    expect(result.summary.students).toBe(1);
  });

  it("sums the amount paid, counts a team purchase in full, and shows 0 with no purchases", () => {
    const second = addCourse(base.instructor.id, "second");
    const a = addStudent("a@x.com");
    purchase(base.user.id, base.course.id, 4999);
    purchase(a.id, base.course.id, 1500); // regional price
    purchase(a.id, base.course.id, 24995); // team purchase, full amount

    const result = getInstructorAnalytics(base.instructor.id);
    const byId = new Map(result.courses.map((c) => [c.id, c]));

    expect(byId.get(base.course.id)!.earnings).toBe(31494);
    expect(byId.get(second.id)!.earnings).toBe(0);
    expect(result.summary.earnings).toBe(31494);
  });

  it("reports each course's lesson count", () => {
    const second = addCourse(base.instructor.id, "second");
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "m", position: 1 })
      .returning()
      .get();
    testDb
      .insert(schema.lessons)
      .values([
        { moduleId: mod.id, title: "l1", position: 1 },
        { moduleId: mod.id, title: "l2", position: 2 },
      ])
      .run();

    const result = getInstructorAnalytics(base.instructor.id);
    const byId = new Map(result.courses.map((c) => [c.id, c]));

    expect(byId.get(base.course.id)!.lessonCount).toBe(2);
    expect(byId.get(second.id)!.lessonCount).toBe(0);
  });

  it("includes draft and archived courses", () => {
    addCourse(base.instructor.id, "draft", schema.CourseStatus.Draft);
    addCourse(base.instructor.id, "old", schema.CourseStatus.Archived);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => c.status).sort()).toEqual([
      "archived",
      "draft",
      "published",
    ]);
  });

  it("never includes another instructor's courses or data", () => {
    const other = testDb
      .insert(schema.users)
      .values({
        name: "Other",
        email: "other@x.com",
        role: schema.UserRole.Instructor,
      })
      .returning()
      .get();
    const theirs = addCourse(other.id, "theirs");
    enroll(base.user.id, theirs.id);
    purchase(base.user.id, theirs.id, 9999);

    const result = getInstructorAnalytics(base.instructor.id);

    expect(result.courses.map((c) => c.id)).toEqual([base.course.id]);
    expect(result.summary).toEqual({ students: 0, earnings: 0, completionRate: null });
  });

  it("returns an empty result for an instructor with no courses", () => {
    const result = getInstructorAnalytics(base.user.id);

    expect(result.courses).toEqual([]);
    expect(result.summary).toEqual({ students: 0, earnings: 0, completionRate: null });
  });

  describe("completion rate", () => {
    function addLessons(courseId: number, count: number) {
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId, title: "m", position: 1 })
        .returning()
        .get();
      return testDb
        .insert(schema.lessons)
        .values(
          Array.from({ length: count }, (_, i) => ({
            moduleId: mod.id,
            title: `l${i}`,
            position: i + 1,
          }))
        )
        .returning()
        .all();
    }

    function complete(userId: number, lessonIds: number[]) {
      testDb
        .insert(schema.lessonProgress)
        .values(
          lessonIds.map((lessonId) => ({
            userId,
            lessonId,
            status: schema.LessonProgressStatus.Completed,
            completedAt: new Date().toISOString(),
          }))
        )
        .run();
    }

    it("counts a student complete only when every lesson is completed", () => {
      const ls = addLessons(base.course.id, 2);
      const a = addStudent("a@x.com");
      const b = addStudent("b@x.com");
      enroll(a.id, base.course.id);
      enroll(b.id, base.course.id);
      complete(a.id, ls.map((l) => l.id));
      complete(b.id, [ls[0].id]);
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: b.id,
          lessonId: ls[1].id,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.courses[0].completionRate).toBe(0.5);
    });

    it("pools the overall rate across enrollments rather than averaging course rates", () => {
      const second = addCourse(base.instructor.id, "second");
      const l1 = addLessons(base.course.id, 1);
      const l2 = addLessons(second.id, 1);
      const students = ["a", "b", "c"].map((n) => addStudent(`${n}@x.com`));
      // course 1: 1 student, complete (100%). course 2: 3 students, 0 complete.
      enroll(students[0].id, base.course.id);
      complete(students[0].id, [l1[0].id]);
      students.forEach((s) => enroll(s.id, second.id));

      const result = getInstructorAnalytics(base.instructor.id);
      const byId = new Map(result.courses.map((c) => [c.id, c]));

      expect(byId.get(base.course.id)!.completionRate).toBe(1);
      expect(byId.get(second.id)!.completionRate).toBe(0);
      expect(result.summary.completionRate).toBe(0.25);
      void l2;
    });

    it("is null for a course with no students or no lessons", () => {
      const noStudents = addCourse(base.instructor.id, "empty");
      addLessons(noStudents.id, 2);
      const noLessons = addCourse(base.instructor.id, "nolessons");
      enroll(base.user.id, noLessons.id);

      const result = getInstructorAnalytics(base.instructor.id);
      const byId = new Map(result.courses.map((c) => [c.id, c]));

      expect(byId.get(noStudents.id)!.completionRate).toBeNull();
      expect(byId.get(noLessons.id)!.completionRate).toBeNull();
      expect(result.summary.completionRate).toBeNull();
    });
  });
});
