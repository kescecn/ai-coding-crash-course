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
    expect(result.summary).toEqual({ students: 0, earnings: 0 });
  });

  it("returns an empty result for an instructor with no courses", () => {
    const result = getInstructorAnalytics(base.user.id);

    expect(result.courses).toEqual([]);
    expect(result.summary).toEqual({ students: 0, earnings: 0 });
  });
});
