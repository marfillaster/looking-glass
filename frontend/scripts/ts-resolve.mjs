import { existsSync } from "node:fs";
export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\.[mc]?[jt]s$/.test(spec)) {
    try {
      const url = new URL(spec + ".ts", ctx.parentURL);
      if (existsSync(url)) return next(spec + ".ts", ctx);
    } catch {}
  }
  return next(spec, ctx);
}
