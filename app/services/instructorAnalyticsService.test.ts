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
      completionRate: null,
      averageQuizScore: null,
      courses: [],
    });
  });

  it("shows $0 and 0 students for a course with no purchases", () => {
    const result = getInstructorAnalytics(base.instructor.id, "all");
    expect(result.courses).toEqual([
      {
        courseId: base.course.id,
        students: 0,
        earnings: 0,
        completionRate: null,
        averageQuizScore: null,
        quizzes: [],
      },
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

  describe("completion rate", () => {
    function addLessons(courseId: number, count: number) {
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId, title: "M", position: 1 })
        .returning()
        .get();
      return Array.from({ length: count }, (_, i) =>
        testDb
          .insert(schema.lessons)
          .values({ moduleId: mod.id, title: `L${i}`, position: i + 1 })
          .returning()
          .get()
      );
    }

    function complete(userId: number, lessonId: number) {
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        })
        .run();
    }

    it("counts a student complete only when every lesson is completed", () => {
      const lessons = addLessons(base.course.id, 3);
      const done = addStudent(1);
      const partial = addStudent(2);
      enroll(done.id, base.course.id);
      enroll(partial.id, base.course.id);
      lessons.forEach((l) => complete(done.id, l.id));
      lessons.slice(0, 2).forEach((l) => complete(partial.id, l.id));

      const result = getInstructorAnalytics(base.instructor.id, "all");
      expect(result.courses[0].completionRate).toBe(0.5);
      expect(result.completionRate).toBe(0.5);
    });

    it("does not count in-progress lessons as completed", () => {
      const lessons = addLessons(base.course.id, 1);
      const a = addStudent(1);
      enroll(a.id, base.course.id);
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: a.id,
          lessonId: lessons[0].id,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      expect(getInstructorAnalytics(base.instructor.id, "all").courses[0].completionRate).toBe(0);
    });

    it("pools the overall rate across enrollments instead of averaging course rates", () => {
      const second = addCourse(base.instructor.id, "second");
      const l1 = addLessons(base.course.id, 1);
      const l2 = addLessons(second.id, 1);
      // Course 1: 1 of 1 complete (100%). Course 2: 1 of 3 complete (33%).
      const s1 = addStudent(1);
      const s2 = addStudent(2);
      const s3 = addStudent(3);
      const s4 = addStudent(4);
      enroll(s1.id, base.course.id);
      complete(s1.id, l1[0].id);
      [s2, s3, s4].forEach((s) => enroll(s.id, second.id));
      complete(s2.id, l2[0].id);

      const result = getInstructorAnalytics(base.instructor.id, "all");
      expect(result.courses.map((c) => c.completionRate)).toEqual([1, 1 / 3]);
      expect(result.completionRate).toBe(0.5); // 2 of 4, not (1 + 1/3) / 2
    });

    it("is null for a course with no students or no lessons", () => {
      const noStudents = addCourse(base.instructor.id, "empty");
      addLessons(noStudents.id, 2);
      const noLessons = addCourse(base.instructor.id, "no-lessons");
      enroll(addStudent(1).id, noLessons.id);

      const result = getInstructorAnalytics(base.instructor.id, "all");
      const rates = Object.fromEntries(
        result.courses.map((c) => [c.courseId, c.completionRate])
      );
      expect(rates[noStudents.id]).toBeNull();
      expect(rates[noLessons.id]).toBeNull();
      expect(result.completionRate).toBeNull();
    });
  });

  describe("quiz scores", () => {
    function addQuiz(courseId: number, title: string, passingScore = 0.7) {
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId, title: "M", position: 1 })
        .returning()
        .get();
      const lesson = testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: "L", position: 1 })
        .returning()
        .get();
      return testDb
        .insert(schema.quizzes)
        .values({ lessonId: lesson.id, title, passingScore })
        .returning()
        .get();
    }

    function attempt(userId: number, quizId: number, score: number) {
      testDb
        .insert(schema.quizAttempts)
        .values({ userId, quizId, score, passed: score >= 0.7 })
        .run();
    }

    it("uses each student's best attempt so a retake doesn't drag the average down", () => {
      const quiz = addQuiz(base.course.id, "Basics");
      const a = addStudent(1);
      const b = addStudent(2);
      attempt(a.id, quiz.id, 0.4); // fail, then pass on retake
      attempt(a.id, quiz.id, 0.9);
      attempt(b.id, quiz.id, 0.5);

      const course = getInstructorAnalytics(base.instructor.id, "all").courses[0];
      expect(course.quizzes).toEqual([
        {
          quizId: quiz.id,
          title: "Basics",
          students: 2,
          averageScore: 0.7,
          passRate: 0.5,
        },
      ]);
      expect(course.averageQuizScore).toBe(0.7);
    });

    it("shows no data for a quiz with no attempts and for a course without any", () => {
      const quiz = addQuiz(base.course.id, "Untouched");

      const result = getInstructorAnalytics(base.instructor.id, "all");
      expect(result.courses[0].quizzes).toEqual([
        {
          quizId: quiz.id,
          title: "Untouched",
          students: 0,
          averageScore: null,
          passRate: null,
        },
      ]);
      expect(result.courses[0].averageQuizScore).toBeNull();
      expect(result.averageQuizScore).toBeNull();
    });

    it("pools best attempts across courses for the overall average and ignores other instructors", () => {
      const second = addCourse(base.instructor.id, "second");
      const q1 = addQuiz(base.course.id, "Q1");
      const q2 = addQuiz(second.id, "Q2");
      const a = addStudent(1);
      const b = addStudent(2);
      attempt(a.id, q1.id, 1);
      attempt(a.id, q2.id, 0.5);
      attempt(b.id, q2.id, 0.9);

      const other = testDb
        .insert(schema.users)
        .values({ name: "O", email: "o@example.com", role: schema.UserRole.Instructor })
        .returning()
        .get();
      const theirs = addQuiz(addCourse(other.id, "theirs").id, "Theirs");
      attempt(a.id, theirs.id, 0);

      const result = getInstructorAnalytics(base.instructor.id, "all");
      expect(result.courses.map((c) => c.averageQuizScore)).toEqual([1, 0.7]);
      // (1 + 0.5 + 0.9) / 3, not the mean of 1 and 0.7
      expect(result.averageQuizScore).toBeCloseTo(0.8);
    });
  });
});
