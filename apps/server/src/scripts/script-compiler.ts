import * as tsModule from "typescript";

export const ts: any = (tsModule as any).default || tsModule;

// Safe helper for JavaScript / MJS syntax validation.
export function safeTranspile(sourceCode: string) {
  const tsAny: any = tsModule;
  const ModuleKind_ESNext = ts.ModuleKind?.ESNext ?? tsAny.ModuleKind?.ESNext ?? 99;
  const ScriptTarget_ES2022 = ts.ScriptTarget?.ES2022 ?? tsAny.ScriptTarget?.ES2022 ?? 9;
  const JsxEmit_None = ts.JsxEmit?.None ?? tsAny.JsxEmit?.None ?? 0;

  const transpileFn = ts.transpileModule || tsAny.transpileModule || tsAny.default?.transpileModule;

  if (typeof transpileFn === "function") {
    return transpileFn(sourceCode, {
      compilerOptions: {
        module: ModuleKind_ESNext,
        target: ScriptTarget_ES2022,
        jsx: JsxEmit_None,
        noEmitOnError: false,
      },
      reportDiagnostics: true,
    });
  }

  return { outputText: sourceCode, diagnostics: [] };
}
