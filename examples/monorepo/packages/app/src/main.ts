import { truncate } from "@example/shared";
import { createTodo, toggle } from "./lib";

const todo = toggle(createTodo("Write the example monorepo"));
console.log(truncate(todo.title, 10, "..."), todo.done);
