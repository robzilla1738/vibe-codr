import { writeFile } from "node:fs/promises";

const path = process.argv.at(-1);
if (!path) process.exit(1);
await writeFile(path, "composed by fixture editor\n", "utf8");
