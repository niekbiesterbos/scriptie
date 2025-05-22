import ast
import json
import sys
import re

# === Call Graph for Recursion Detection ===


class CallGraphBuilder(ast.NodeVisitor):
    def __init__(self):
        self.function_defs = set()
        self.calls = {}
        self.current_function = None

    def visit_FunctionDef(self, node):
        self.function_defs.add(node.name)
        prev = self.current_function
        self.current_function = node.name
        self.calls.setdefault(node.name, set())
        self.generic_visit(node)
        self.current_function = prev

    def visit_ClassDef(self, node):
        # Qualify method names as Class.method
        for item in node.body:
            if isinstance(item, ast.FunctionDef):
                self.function_defs.add(f"{node.name}.{item.name}")
        self.generic_visit(node)

    def visit_Call(self, node):
        if self.current_function:
            # Plain function calls
            if isinstance(node.func, ast.Name):
                callee = node.func.id
                if callee in self.function_defs:
                    self.calls[self.current_function].add(callee)
            # Method calls on self
            elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                if node.func.value.id == 'self':
                    callee = f"self.{node.func.attr}"
                    if callee in self.function_defs:
                        self.calls[self.current_function].add(callee)
        self.generic_visit(node)


def has_recursion(tree):
    cg = CallGraphBuilder()
    cg.visit(tree)

    # Direct recursion
    for func, callees in cg.calls.items():
        if func in callees:
            return True

    # Indirect recursion via cycle detection
    def dfs(func, path):
        if func in path:
            return True
        path.add(func)
        for callee in cg.calls.get(func, []):
            if dfs(callee, path.copy()):
                return True
        return False

    for func in cg.calls:
        if dfs(func, set()):
            return True
    return False


# === Memoization Detection ===
class MemoizationDetector(ast.NodeVisitor):
    def __init__(self):
        self.decorator = False
        self.lookup = False
        self.assign = False
        self.cache_init = False
        self.potential_names = {
            'memo', 'cache', 'dp', 'results', 'cached', 'lookup_table', 'memoized', 'seen'
        }

    def visit_FunctionDef(self, node):
        # Decorator-based memoization
        for dec in node.decorator_list:
            if isinstance(dec, ast.Name) and dec.id in {'lru_cache', 'cache', 'memoize', 'memoized'}:
                self.decorator = True
            elif isinstance(dec, ast.Call) and isinstance(dec.func, ast.Name) and dec.func.id in {'lru_cache', 'memoize', 'cached'}:
                self.decorator = True
            elif isinstance(dec, ast.Attribute) and dec.attr in {'lru_cache', 'cache', 'memoize', 'cached'}:
                self.decorator = True
        # Detect cache dict initialization
        for stmt in node.body:
            if isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    if isinstance(target, ast.Name) and any(n in target.id.lower() for n in self.potential_names):
                        if isinstance(stmt.value, ast.Dict) or \
                           (isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name) and stmt.value.func.id == 'dict'):
                            self.cache_init = True
        self.generic_visit(node)

    def visit_If(self, node):
        # Lookup patterns
        # if key in cache
        if isinstance(node.test, ast.Compare):
            left = node.test.left
            if any(isinstance(left, ast.Name) and isinstance(node.ops[0], ast.In) and
                   isinstance(node.comparators[0], ast.Name) and
                   any(n in node.comparators[0].id.lower()
                       for n in self.potential_names)
                   for _ in [None]):
                self.lookup = True
            # if cache.get(key) is not None
            if isinstance(left, ast.Call) and isinstance(left.func, ast.Attribute) and left.func.attr == 'get' and \
               isinstance(left.func.value, ast.Name) and any(n in left.func.value.id.lower() for n in self.potential_names):
                self.lookup = True
        # return cache[key]
        for stmt in node.body:
            if isinstance(stmt, ast.Return):
                val = stmt.value
                if isinstance(val, ast.Subscript) and isinstance(val.value, ast.Name) and \
                   any(n in val.value.id.lower() for n in self.potential_names):
                    self.lookup = True
        self.generic_visit(node)

    def visit_Assign(self, node):
        # cache[key] = result
        tgt = node.targets[0]
        if isinstance(tgt, ast.Subscript) and isinstance(tgt.value, ast.Name) and \
           any(n in tgt.value.id.lower() for n in self.potential_names):
            self.assign = True
        # result = cache.get(key, compute())
        if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'get' and \
           isinstance(node.value.func.value, ast.Name) and any(n in node.value.func.value.id.lower() for n in self.potential_names):
            self.lookup = True
        self.generic_visit(node)


def has_memoization(tree):
    det = MemoizationDetector()
    det.visit(tree)
    return det.decorator or ((det.lookup and det.assign) or (det.cache_init and (det.lookup or det.assign)))


# === Dynamic Programming Detection ===
class DPDetector(ast.NodeVisitor):
    def __init__(self):
        self.dp_arrays = set()
        self.potential_names = {'dp', 'table', 'matrix', 'grid', 'memo', 'opt', 'cost', 'value',
                                'dist', 'max_values', 'min_costs'}
        self.has_init = False
        self.has_update = False
        self.base_case = False
        self.subproblem = False
        self.loop_depth = 0
        self.max_depth = 0
        self.fills = 0

    def visit_Assign(self, node):
        tgt = node.targets[0]
        val = node.value
        # Initialization: list literal or numpy array
        if isinstance(tgt, ast.Name) and (isinstance(val, (ast.List, ast.ListComp)) or
           (isinstance(val, ast.Call) and isinstance(val.func, ast.Attribute) and
            val.func.attr in {'zeros', 'ones', 'full', 'array', 'ndarray', 'empty'} and
                isinstance(val.func.value, ast.Name) and val.func.value.id in {'np', 'numpy'})):
            if any(name in tgt.id.lower() for name in self.potential_names):
                self.dp_arrays.add(tgt.id)
                self.has_init = True
        # Base case: dp[0] = something
        if isinstance(tgt, ast.Subscript) and isinstance(tgt.value, ast.Name) and tgt.value.id in self.dp_arrays:
            self.base_case = True
        self.generic_visit(node)

    def visit_For(self, node):
        self.loop_depth += 1
        self.max_depth = max(self.max_depth, self.loop_depth)
        # Updates: dp[...] = expr involving dp[...]?
        for sub in ast.walk(node):
            if isinstance(sub, ast.Assign):
                lhs = sub.targets[0]
                if isinstance(lhs, ast.Subscript) and isinstance(lhs.value, ast.Name) and lhs.value.id in self.dp_arrays:
                    self.has_update = True
                    self.fills += 1
                    # Check subproblem usage
                    for nn in ast.walk(sub.value):
                        if isinstance(nn, ast.Subscript) and isinstance(nn.value, ast.Name) and nn.value.id in self.dp_arrays:
                            self.subproblem = True
        self.generic_visit(node)
        self.loop_depth -= 1


def has_dynamic_programming(tree):
    det = DPDetector()
    det.visit(tree)
    basic = det.has_init and det.has_update
    soup = det.subproblem and det.max_depth >= 1 and det.fills > 0
    complex_dp = det.max_depth >= 2 and det.fills >= 3
    typical = det.base_case and det.max_depth >= 1 and det.subproblem
    return basic or soup or complex_dp or typical


# === Graph Traversal Detection ===
class GraphDetector(ast.NodeVisitor):
    def __init__(self):
        self.graph_lib = False
        self.queue = False
        self.stack = False
        self.recursive = False
        self.visited = False
        self.bfs_loop = False
        self.adj_data = False
        self.neighbor_iter = False
        self.graph_keywords = {'graph', 'edge', 'vertex',
                               'node', 'neighbor', 'adj', 'path', 'dfs', 'bfs'}
        self.vars = set()
        self.current = None

    def visit_Import(self, node):
        for n in node.names:
            if n.name in {'networkx', 'igraph', 'graph-tool', 'graphviz'}:
                self.graph_lib = True
            if n.name in {'collections', 'queue', 'heapq'}:
                self.queue = True
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module in {'networkx', 'igraph', 'graph-tool', 'graphviz'}:
            self.graph_lib = True
        if node.module == 'collections':
            for n in node.names:
                if n.name == 'deque':
                    self.queue = True
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        prev = self.current
        self.current = node.name
        if any(kw in node.name.lower() for kw in self.graph_keywords):
            self.graph_lib = True
        for arg in node.args.args:
            if any(kw in arg.arg.lower() for kw in self.graph_keywords):
                self.vars.add(arg.arg)
        self.generic_visit(node)
        self.current = prev

    def visit_Assign(self, node):
        tgt = node.targets[0]
        if isinstance(tgt, ast.Name):
            name = tgt.id.lower()
            if any(kw in name for kw in self.graph_keywords):
                self.vars.add(tgt.id)
            if isinstance(node.value, ast.Dict) and any(kw in name for kw in {'graph', 'adj'}):
                self.adj_data = True
            if isinstance(node.value, ast.ListComp) and any(kw in name for kw in {'matrix', 'adj'}):
                self.adj_data = True
        self.generic_visit(node)

    def visit_Call(self, node):
        # Recursive DFS
        if isinstance(node.func, ast.Name) and node.func.id == self.current:
            self.recursive = True
        # visited.add
        if isinstance(node.func, ast.Attribute) and node.func.attr in {'add', 'update'} and isinstance(node.func.value, ast.Name) and node.func.value.id in {'visited', 'seen'}:
            self.visited = True
        # queue operations
        if isinstance(node.func, ast.Attribute) and node.func.attr in {'append', 'appendleft', 'pop', 'popleft', 'put', 'get'} and \
           isinstance(node.func.value, ast.Name) and node.func.value.id in {'queue', 'q', 'stack', 'frontier'}:
            self.queue = True
        self.generic_visit(node)

    def visit_For(self, node):
        # neighbor iteration
        if isinstance(node.iter, ast.Subscript) and isinstance(node.iter.value, ast.Name) and node.iter.value.id in self.vars:
            self.neighbor_iter = True
        self.generic_visit(node)

    def visit_While(self, node):
        # BFS-like pattern
        if isinstance(node.test, ast.Name) and node.test.id in {'queue', 'q', 'stack', 'frontier'}:
            pop = False
            add = False
            vis = False
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and isinstance(sub.func.value, ast.Name):
                    n = sub.func.value.id
                    m = sub.func.attr
                    if n in {'queue', 'q', 'frontier'} and m in {'pop', 'popleft', 'get'}:
                        pop = True
                    if n in {'queue', 'frontier'} and m in {'append', 'put'}:
                        add = True
                    if n in {'visited', 'seen'} and m in {'add', 'update'}:
                        vis = True
            if pop and (add or vis):
                self.bfs_loop = True
        self.generic_visit(node)


def has_graph_traversal(tree):
    det = GraphDetector()
    det.visit(tree)
    bfs_pat = det.queue and det.visited
    dfs_pat = (det.stack or det.recursive) and det.visited
    data_pat = det.adj_data and det.neighbor_iter
    return det.graph_lib or bfs_pat or dfs_pat or det.bfs_loop or data_pat


# === Greedy Algorithm Detection ===
class GreedyDetector(ast.NodeVisitor):
    def __init__(self):
        self.sort_calls = 0
        self.min_max_calls = 0
        self.heap = False
        self.pq = False
        self.local_opt = 0
        self.accumulate = False
        self.after_sort = False
        self.key_sort = False
        self.current = None

    def visit_FunctionDef(self, node):
        prev = self.current
        self.current = node.name
        self.generic_visit(node)
        self.current = prev

    def visit_Import(self, node):
        for n in node.names:
            if n.name == 'heapq':
                self.heap = True
            if n.name == 'queue':
                self.pq = True
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module == 'heapq':
            self.heap = True
        if node.module == 'queue' and any(n.name == 'PriorityQueue' for n in node.names):
            self.pq = True
        self.generic_visit(node)

    def visit_Call(self, node):
        # sorted(...)
        if isinstance(node.func, ast.Name) and node.func.id == 'sorted':
            self.sort_calls += 1
            for kw in node.keywords:
                if kw.arg == 'key':
                    self.key_sort = True
        # .sort()
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'sort':
            self.sort_calls += 1
            for kw in node.keywords:
                if kw.arg == 'key':
                    self.key_sort = True
        # min/max
        if isinstance(node.func, ast.Name) and node.func.id in {'min', 'max'}:
            self.min_max_calls += 1
        # heap operations
        if isinstance(node.func, ast.Name) and node.func.id in {'heappush', 'heappop', 'heapify'}:
            self.heap = True
            self.local_opt += 1
        self.generic_visit(node)

    def visit_Assign(self, node):
        # Accumulation pattern: x = x + ...
        if isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.BinOp):
            if isinstance(node.value.left, ast.Name) and node.value.left.id == node.targets[0].id:
                self.accumulate = True
        self.generic_visit(node)

    def visit_For(self, node):
        # Detect iteration after sort in same block
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call) and ((isinstance(sub.func, ast.Name) and sub.func.id == 'sorted') or
               (isinstance(sub.func, ast.Attribute) and sub.func.attr == 'sort')):
                self.after_sort = True
        self.generic_visit(node)


def has_greedy_algorithm(tree):
    det = GreedyDetector()
    det.visit(tree)
    if det.heap or det.pq:
        return True
    if det.sort_calls and (det.local_opt > 0 or det.key_sort or det.after_sort):
        return True
    if det.min_max_calls >= 3:
        return True
    if det.accumulate and det.sort_calls > 0:
        return True
    return False


# === File Analysis Entry Point ===
def analyze_file(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        code = f.read()
    try:
        tree = ast.parse(code)
        rec = has_recursion(tree)
        mem = has_memoization(tree)
        dp = has_dynamic_programming(tree)
        gf = has_graph_traversal(tree)
        gr = has_greedy_algorithm(tree)
        strategies = []
        if mem and rec:
            strategies.append("MemoizedRecursion")
        elif rec:
            strategies.append("Recursion")
        elif dp:
            strategies.append("DynamicProgramming")
        elif gf:
            strategies.append("GraphTraversal")
        elif gr:
            strategies.append("GreedyAlgorithm")
        else:
            strategies.append("None")
        print(json.dumps(strategies))
        return True
    except SyntaxError:
        print(json.dumps(["SyntaxError"]))
        return False


if __name__ == "__main__":
    if len(sys.argv) > 1:
        analyze_file(sys.argv[1])
    else:
        print("Please provide a Python file to analyze")
