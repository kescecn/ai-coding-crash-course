import type { QuizRow } from "~/services/instructorAnalyticsService";

export function formatPercent(fraction: number | null) {
  return fraction === null ? "No data yet" : `${Math.round(fraction * 100)}%`;
}

export function QuizPerformanceTable({ quizzes }: { quizzes: QuizRow[] }) {
  if (quizzes.length === 0) return null;

  return (
    <table className="mt-4 w-full text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th className="pb-1 font-medium">Quiz</th>
          <th className="pb-1 font-medium">Students</th>
          <th className="pb-1 font-medium">Avg score</th>
          <th className="pb-1 font-medium">Pass rate</th>
        </tr>
      </thead>
      <tbody>
        {quizzes.map((quiz) => (
          <tr key={quiz.quizId} className="border-t">
            <td className="py-1 pr-2">{quiz.title}</td>
            {quiz.students === 0 ? (
              <td colSpan={3} className="py-1 text-muted-foreground">
                No data yet
              </td>
            ) : (
              <>
                <td className="py-1">{quiz.students}</td>
                <td className="py-1">{formatPercent(quiz.avgScore)}</td>
                <td className="py-1">{formatPercent(quiz.passRate)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
