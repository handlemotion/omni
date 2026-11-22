import { MiniMonth } from "./mini-month.tsx";
import { TodoList } from "./todo-list.tsx";

/** The calendar's sidebar: the month and the member's to-dos. */
export function CalendarNav() {
  return (
    <>
      <MiniMonth />
      <TodoList />
    </>
  );
}
