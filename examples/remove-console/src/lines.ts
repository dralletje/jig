export function lines(ids: string[]): string {
  let out = "";

  console.log("start");

  for (const id of ids) {
    console.log("one", id);
    console.log("two", id);
    out += id;
  }

  /* before */ console.log("block comment before"); // after
  out += "!";

  console.log("multi-line", {
    ids,
  }); /* multi
  line */

  console.log("end");
  return out;
}
