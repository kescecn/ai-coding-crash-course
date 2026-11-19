import { formatPercent } from "~/lib/utils";

type QuizRow = {
  quizId: number;
  title: string;
  students: number;
  averageScore: number | null;
  passRate: number | null;
};

export function QuizScoreTable({ quizzes }: { quizzes: QuizRow[] }) {
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
            <td className="py-1">{quiz.students}</td>
            <td className="py-1">{formatPercent(quiz.averageScore)}</td>
            <td className="py-1">{formatPercent(quiz.passRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
