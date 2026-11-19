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

function addStudent(n: number) {
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${n}`,
      email: `s${n}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

function purchase(userId: number, courseId: number, pricePaid: number) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, pricePaid, country: "US" })
    .returning()
    .get();
}

describe("getInstructorAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("returns zeros and no courses for an instructor with no courses", () => {
    const other = addStudent(1);
    expect(getInstructorAnalytics(other.id, "all")).toEqual({
      totalStudents: 0,
      totalEarnings: 0,
      courses: [],
    });
  });

  it("shows $0 and 0 students for a course with no purchases", () => {
    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.courses).toEqual([
      { courseId: base.course.id, students: 0, earnings: 0 },
    ]);
    expect(result.totalStudents).toBe(0);
    expect(result.totalEarnings).toBe(0);
  });

  it("sums the amount actually paid, not the list price", () => {
    const a = addStudent(1);
    const b = addStudent(2);
    enroll(a.id, base.course.id);
    enroll(b.id, base.course.id);
    purchase(a.id, base.course.id, 4999);
    purchase(b.id, base.course.id, 2500);

    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.courses[0]).toMatchObject({ students: 2, earnings: 7499 });
    expect(result.totalEarnings).toBe(7499);
  });

  it("counts a student once per course despite duplicate enrollments", () => {
    const a = addStudent(1);
    enroll(a.id, base.course.id);
    enroll(a.id, base.course.id);

    expect(getInstructorAnalytics(base.instructor.id, "all").courses[0].students).toBe(1);
  });

  it("counts seat redemptions as students and a team purchase in full", () => {
    const buyer = addStudent(1);
    const seat1 = addStudent(2);
    const seat2 = addStudent(3);
    const team = testDb.insert(schema.teams).values({}).returning().get();
    const p = purchase(buyer.id, base.course.id, 5 * 1000);
    testDb
      .insert(schema.coupons)
      .values({ teamId: team.id, courseId: base.course.id, code: "A", purchaseId: p.id })
      .run();
    enroll(seat1.id, base.course.id);
    enroll(seat2.id, base.course.id);

    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.courses[0]).toMatchObject({ students: 2, earnings: 5000 });
  });

  it("counts a student enrolled in two courses once in the total", () => {
    const second = addCourse(base.instructor.id, "second");
    const a = addStudent(1);
    enroll(a.id, base.course.id);
    enroll(a.id, second.id);

    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.totalStudents).toBe(1);
    expect(result.courses.map((c) => c.students)).toEqual([1, 1]);
  });

  it("includes draft, published and archived courses", () => {
    const draft = addCourse(base.instructor.id, "draft", schema.CourseStatus.Draft);
    const archived = addCourse(base.instructor.id, "archived", schema.CourseStatus.Archived);
    const a = addStudent(1);
    enroll(a.id, draft.id);
    purchase(a.id, archived.id, 1000);

    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.courses.map((c) => c.courseId).sort()).toEqual(
      [base.course.id, draft.id, archived.id].sort()
    );
    expect(result.totalStudents).toBe(1);
    expect(result.totalEarnings).toBe(1000);
  });

  it("ignores other instructors' courses", () => {
    const otherInstructor = testDb
      .insert(schema.users)
      .values({ name: "Other", email: "o@example.com", role: schema.UserRole.Instructor })
      .returning()
      .get();
    const theirs = addCourse(otherInstructor.id, "theirs");
    const a = addStudent(1);
    enroll(a.id, theirs.id);
    purchase(a.id, theirs.id, 9999);

    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.courses.map((c) => c.courseId)).toEqual([base.course.id]);
    expect(result.totalStudents).toBe(0);
    expect(result.totalEarnings).toBe(0);
  });
});
