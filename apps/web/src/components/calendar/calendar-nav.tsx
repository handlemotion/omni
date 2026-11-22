import { CalendarSwitcher } from "./calendar-switcher.tsx";
import { MiniMonth } from "./mini-month.tsx";
import { TodoList } from "./todo-list.tsx";

/** The calendar's sidebar: the month, the member's to-dos, and at its foot, the calendars. */
export function CalendarNav() {
  return (
    <>
      <MiniMonth />
      <TodoList />
      <div className="mt-auto px-0.5 pt-2">
        <CalendarSwitcher />
      </div>
    </>
  );
}
