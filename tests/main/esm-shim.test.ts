import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

// electron-vite gives every main-process bundle its own `__dirname` and
// `__filename`, so a module that declares either makes the bundle a syntax
// error at load: the app fails to start while its tests, which never load the
// bundle, still pass. Modules use `import.meta.dirname` instead.
const SHIMMED = new Set(["__dirname", "__filename"]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

function declaredShims(file: string): string[] {
  const ast = parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
  const found: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && SHIMMED.has(declarator.id.name)) found.push(declarator.id.name);
      }
    }
    if (declaration?.type === "FunctionDeclaration" && declaration.id && SHIMMED.has(declaration.id.name)) found.push(declaration.id.name);
  }
  return found;
}

describe("main-process modules and electron-vite's shims", () => {
  it("declare no __dirname or __filename of their own", () => {
    const root = path.join(process.cwd(), "src", "main");
    const offenders = sourceFiles(root).flatMap((file) =>
      declaredShims(file).map((name) => `${path.relative(root, file)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("finds such a declaration", () => {
    const probe = path.join(process.cwd(), "node_modules", ".cache", "esm-shim-probe.ts");
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'const __dirname = "x";\nexport const value = __dirname;\n');
    try {
      expect(declaredShims(probe)).toEqual(["__dirname"]);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
});
