import { Form, Link, useSubmit } from "react-router";
import type { Route } from "./+types/instructor";
import {
  getInstructorAnalytics,
  parseRangePreset,
  type RangePreset,
} from "~/services/instructorAnalyticsService";
import { getCurrentUserId } from "~/lib/session";
import { getUserById } from "~/services/userService";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, BookOpen, GraduationCap, Plus, Users } from "lucide-react";
import { CourseImage } from "~/components/course-image";
import { data, isRouteErrorResponse } from "react-router";
import { CourseStatus, UserRole } from "~/db/schema";
import { formatPrice } from "~/lib/utils";
import { CheckCircle2, ClipboardCheck, DollarSign } from "lucide-react";
import {
  QuizPerformanceTable,
  formatPercent,
} from "~/components/quiz-performance-table";

const RANGE_LABELS: Record<RangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "12m": "Last 12 months",
  all: "All time",
};

function RangeSelector({ range }: { range: RangePreset }) {
  const submit = useSubmit();
  return (
    <Form method="get" className="mb-4 flex items-center justify-end gap-2">
      <label htmlFor="range" className="text-sm text-muted-foreground">
        Date range
      </label>
      <select
        id="range"
        name="range"
        value={range}
        onChange={(e) => submit(e.currentTarget.form)}
        className="rounded-md border bg-background px-3 py-2 text-sm"
      >
        {(Object.keys(RANGE_LABELS) as RangePreset[]).map((preset) => (
          <option key={preset} value={preset}>
            {RANGE_LABELS[preset]}
          </option>
        ))}
      </select>
    </Form>
  );
}

function formatCompletionRate(rate: number | null) {
  return rate === null ? "No data yet" : `${Math.round(rate * 100)}%`;
}

export function meta() {
  return [
    { title: "My Courses — Cadence" },
    { name: "description", content: "Manage your courses" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view your courses.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user || user.role !== UserRole.Instructor) {
    throw data("Only instructors can access this page.", {
      status: 403,
    });
  }

  const range = parseRangePreset(new URL(request.url).searchParams.get("range"));
  const analytics = getInstructorAnalytics(currentUserId, range);

  return { range, summary: analytics.summary, courses: analytics.courses };
}

function statusBadge(status: string) {
  switch (status) {
    case CourseStatus.Published:
      return (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Published
        </span>
      );
    case CourseStatus.Draft:
      return (
        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
          Draft
        </span>
      );
    case CourseStatus.Archived:
      return (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
          Archived
        </span>
      );
    default:
      return null;
  }
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="mt-2 h-5 w-72" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="flex flex-col">
            <Skeleton className="aspect-video rounded-b-none rounded-t-lg" />
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
            </CardHeader>
            <CardContent className="flex-1">
              <div className="flex items-center gap-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-20" />
              </div>
            </CardContent>
            <CardFooter>
              <Skeleton className="h-10 w-full" />
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function InstructorDashboard({
  loaderData,
}: Route.ComponentProps) {
  const { range, summary, courses } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">My Courses</span>
      </nav>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Courses</h1>
          <p className="mt-1 text-muted-foreground">
            Manage your courses and track enrollments
          </p>
        </div>
        <Link to="/instructor/new">
          <Button>
            <Plus className="mr-2 size-4" />
            New Course
          </Button>
        </Link>
      </div>

      {courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first course to get started.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      ) : (
        <>
        <RangeSelector range={range} />
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="flex items-center gap-3">
              <Users className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Students</p>
                <p className="text-2xl font-bold">{summary.students}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3">
              <DollarSign className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Earnings</p>
                <p className="text-2xl font-bold">
                  {formatPrice(summary.earnings)}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3">
              <CheckCircle2 className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Completion rate</p>
                <p className="text-2xl font-bold">
                  {formatCompletionRate(summary.completionRate)}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3">
              <ClipboardCheck className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Avg quiz score</p>
                <p className="text-2xl font-bold">
                  {formatPercent(summary.avgQuizScore)}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <Card key={course.id} className="flex flex-col overflow-hidden pt-0">
              <Link to={`/courses/${course.slug}`} className="aspect-video overflow-hidden">
                <CourseImage
                  src={course.coverImageUrl}
                  alt={course.title}
                  className="h-full w-full object-cover transition-transform hover:scale-105"
                />
              </Link>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to={`/courses/${course.slug}`}
                    className="text-lg font-semibold leading-tight hover:text-primary"
                  >
                    {course.title}
                  </Link>
                  {statusBadge(course.status)}
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {course.description}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="size-4" />
                    <span>
                      {course.lessonCount}{" "}
                      {course.lessonCount === 1 ? "lesson" : "lessons"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Users className="size-4" />
                    <span>
                      {course.students}{" "}
                      {course.students === 1 ? "student" : "students"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <DollarSign className="size-4" />
                    <span>{formatPrice(course.earnings)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-4" />
                    <span>{formatCompletionRate(course.completionRate)}</span>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <ClipboardCheck className="size-4" />
                  <span>Avg quiz score: {formatPercent(course.avgQuizScore)}</span>
                </div>
                <QuizPerformanceTable quizzes={course.quizzes} />
              </CardContent>
              <CardFooter>
                <Link to={`/instructor/${course.id}`} className="w-full">
                  <Button className="w-full" variant="outline">
                    <BookOpen className="mr-2 size-4" />
                    Edit Course
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
        </>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your courses.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
