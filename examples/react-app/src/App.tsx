import React from "react";
import Counter from "./components/Counter";

export default function App() {
  return (
    <main>
      <h1>Counter</h1>
      <Counter start={5} />
    </main>
  );
}
