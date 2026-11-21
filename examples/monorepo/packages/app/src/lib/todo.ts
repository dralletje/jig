import { nextId, truncate } from "@example/shared";

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

export function createTodo(title: string) {
  return { id: nextId("todo"), title: truncate(title, 40, "…"), done: false };
}

export function toggle(todo: Todo) {
  return { ...todo, done: !todo.done };
}
