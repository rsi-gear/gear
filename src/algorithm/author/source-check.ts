import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const forbiddenModules = /^(?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https|dgram|worker_threads)$|^(?:openai|@anthropic-ai\/sdk|@google\/generative-ai|aws-sdk)$/;
const forbiddenCalls = new Set(['fetch', 'setTimeout', 'setInterval', 'eval']);
const forbiddenProperties = new Set(['Date.now', 'Math.random', 'Promise.all', 'Promise.race', 'Promise.any', 'crypto.randomUUID', 'process.env']);
function contained(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail);
}

/** A0 diagnostics and local-import closure check; this is not a sandbox. */
export function checkAuthorModuleSource(path: string, sourceRoot = dirname(path), hostRoot?: string): void {
  const authorRoot = realpathSync(sourceRoot);
  const trustedHost = hostRoot ? realpathSync(hostRoot) : null;
  const seen = new Set<string>();
  const scan = (named: string): void => {
    const filePath = realpathSync(named);
    if (trustedHost && contained(trustedHost, filePath)) return; // separately sealed Gear host closure
    if (!contained(authorRoot, filePath)) throw new Error(`${named}: local author import escapes frozen source root`);
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const source = readFileSync(filePath, 'utf8');
    const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true,
      filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const diagnostic = (node: ts.Node, reason: string): never => {
      const location = file.getLineAndCharacterOfPosition(node.getStart(file));
      throw new Error(`${filePath}:${location.line + 1}:${location.character + 1}: ${reason}`);
    };
    const importTarget = (node: ts.Node, specifier: string): void => {
      if (forbiddenModules.test(specifier)) diagnostic(node, `direct external IO/SDK import ${specifier}; use a managed operation`);
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
        const target = specifier.startsWith('file:') ? fileURLToPath(specifier)
          : isAbsolute(specifier) ? specifier : resolve(dirname(filePath), specifier);
        const resolved = (() => {
          try { return realpathSync(target); }
          catch { return diagnostic(node, `unresolved local author import ${specifier}`); }
        })();
        if (trustedHost && contained(trustedHost, resolved)) return;
        if (!contained(authorRoot, resolved)) diagnostic(node, `local author import escapes frozen source root: ${specifier}`);
        scan(resolved);
      } else {
        diagnostic(node, `bare package import is outside the frozen A0 author closure: ${specifier}`);
      }
    };
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Const))
        diagnostic(statement, 'top-level mutable bindings are not supported in A0 author workflow captures');
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) importTarget(node, node.moduleSpecifier.text);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        importTarget(node, node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (expression.kind === ts.SyntaxKind.ImportKeyword) diagnostic(node, 'dynamic import is outside the frozen A0 author source closure');
        if (ts.isIdentifier(expression) && forbiddenCalls.has(expression.text))
          diagnostic(node, `${expression.text} is unmanaged; use ctx.operation or ctx.parallel`);
        if (ts.isPropertyAccessExpression(expression)) {
          const text = expression.getText(file);
          if (forbiddenProperties.has(text)) diagnostic(node, `${text} is unmanaged; use ctx.now, ctx.randomSeed, or ctx.parallel`);
        }
        if (ts.isIdentifier(expression) && expression.text === 'require') {
          const argument = node.arguments[0];
          if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument))
            diagnostic(node, 'dynamic require is outside the frozen A0 author source closure');
          importTarget(node, (argument as ts.StringLiteral).text);
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.getText(file) === 'process.env')
        diagnostic(node, 'process.env is mutable; seal it in run config');
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Promise')
        diagnostic(node, 'bare Promise construction is not a managed await');
      if (ts.isTryStatement(node) && node.finallyBlock) {
        const inspectFinally = (child: ts.Node): void => {
          if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
            && ts.isIdentifier(child.expression.expression) && child.expression.expression.text === 'ctx')
            diagnostic(child, 'managed operations in finally are not a recovery contract');
          ts.forEachChild(child, inspectFinally);
        };
        inspectFinally(node.finallyBlock);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  };
  scan(path);
}
