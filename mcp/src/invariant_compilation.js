const { isDeepStrictEqual } = require('node:util');
const antlr4 = require('antlr4/index');
const { LTLLexer } = require('../../fret-electron/support/LTLParser/LTLLexer');
const { LTLParser } = require('../../fret-electron/support/LTLParser/LTLParser');
const { LTLASTAnalyzer } = require('../../fret-electron/support/LTLParser/LTLASTAnalyzer');
const { ASTtoCoCo } = require('../../fret-electron/support/LTLParser/LTLASTSemantics');

// Use FRET's grammar and AST. Reject partial parses and function calls: the
// existing visitor does not distinguish a function named And from the And node.
function parseFormula(text) {
  let invalid = false;
  const listener = new antlr4.error.ErrorListener();
  listener.syntaxError = () => { invalid = true; };
  const lexer = new LTLLexer(new antlr4.InputStream(text));
  lexer.removeErrorListeners();
  lexer.addErrorListener(listener);
  const tokens = new antlr4.CommonTokenStream(lexer);
  const parser = new LTLParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener(listener);
  const tree = parser.bool_expr();
  const hasCall = node =>
    ((node instanceof LTLParser.BoolPredContext || node instanceof LTLParser.ArithTermContext) && node.lp()) ||
    node.children?.some(hasCall);
  if (invalid || tokens.LA(1) !== antlr4.Token.EOF || hasCall(tree)) return null;
  return new LTLASTAnalyzer().visit(tree);
}

const currentOperators = {
  Not: 1, Negate: 1, And: 2, Or: 2, ExclusiveOr: 2, Implies: 2, Equiv: 2,
  Plus: 2, Minus: 2, Divide: 2, Mult: 2, Mod: 2, Expt: 2,
  LessThan: 2, LessThanOrEqual: 2, NotEqual: 2, Equal: 2, GreaterThan: 2, GreaterThanOrEqual: 2
};

const isNode = (ast, operator, arity) => Array.isArray(ast) && ast[0] === operator && ast.length === arity + 1;
const negate = ast => isNode(ast, 'Not', 1) ? ast[1] : ['Not', ast];

function compileInvariant({ ptSmv, ptLustre, ftInf, variables }) {
  const unchanged = { formula: ptLustre, relation: 'unsupported', rules: [] };
  if (typeof ptSmv !== 'string' || typeof ftInf !== 'string') return unchanged;
  const original = parseFormula(ptSmv);
  const future = parseFormula(ftInf);
  if (original === null || future === null || !isNode(future, 'Globally', 1)) return unchanged;
  const declared = new Set(variables);
  const current = ast => {
    if (!Array.isArray(ast)) return typeof ast === 'boolean' ||
      (typeof ast === 'string' && (declared.has(ast) || Number.isFinite(Number(ast))));
    return Object.hasOwn(currentOperators, ast[0]) && ast.length === currentOperators[ast[0]] + 1 &&
      ast.slice(1).every(current);
  };
  const rules = new Set();
  const reduce = ast => {
    if (isNode(ast, 'Historically', 1) && current(ast[1])) {
      rules.add('historical_current');
      return { ast: ast[1], future: ast[1], relation: 'equivalent' };
    }
    if (isNode(ast, 'Or', 2) && isNode(ast[1], 'Historically', 1) &&
        isNode(ast[1][1], 'Not', 1) && isNode(ast[2], 'Not', 1)) {
      const trigger = ast[1][1][1];
      const since = ast[2][1];
      if (isNode(since, 'Since', 2) && isNode(since[2], 'And', 2) &&
          isDeepStrictEqual(since[1], since[2][1]) && isDeepStrictEqual(trigger, since[2][2])) {
        const response = negate(since[1]);
        if (current(trigger) && current(response)) {
          // At every finite prefix, all monitor values have held iff every
          // trigger has its response immediately. This implies eventual response.
          rules.add('eventual_monitor_current');
          return { ast: ['Implies', trigger, response],
            future: ['Implies', trigger, ['Future', response]], relation: 'sufficient' };
        }
      }
    }
    if (isNode(ast, 'And', 2)) {
      const left = reduce(ast[1]);
      const right = reduce(ast[2]);
      if (left && right) return {
        ast: ['And', left.ast, right.ast], future: ['And', left.future, right.future],
        relation: [left.relation, right.relation].includes('sufficient') ? 'sufficient' : 'equivalent'
      };
    }
    if (current(ast)) return { ast, future: ast, relation: 'equivalent' };
    return null;
  };
  const reduced = reduce(original);
  if (!reduced || !isDeepStrictEqual(reduced.future, future[1])) return unchanged;
  return { formula: rules.size ? ASTtoCoCo(reduced.ast) : ptLustre,
    relation: reduced.relation, rules: [...rules] };
}

module.exports = { compileInvariant };
