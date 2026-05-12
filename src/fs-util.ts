import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { errorCode } from "./errors.js";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

export async function readTextIfExists(target: string): Promise<string> {
  if (!(await fileExists(target))) {
    return "";
  }
  return readFile(target, "utf8");
}

export async function readJsonWithSchema<T>(target: string, schema: z.ZodType<T>): Promise<T> {
  const content = await readFile(target, "utf8");
  return schema.parse(JSON.parse(content));
}

export async function atomicWriteText(target: string, content: string): Promise<void> {
  await ensureDir(path.dirname(target));
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, content, "utf8");
  await rename(temp, target);
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}
