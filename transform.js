module.exports = function(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // 1. Add await to getOne, getAll, runSql calls
  root.find(j.CallExpression, {
    callee: { name: n => ['getOne', 'getAll', 'runSql'].includes(n) }
  }).forEach(path => {
    // If it's already awaited, skip
    if (path.parentPath.node.type === 'AwaitExpression') return;
    j(path).replaceWith(j.awaitExpression(path.node));
  });

  // 2. Make all functions that contain await asynchronous
  let madeChanges = true;
  while(madeChanges) {
    madeChanges = false;
    root.find(j.AwaitExpression).forEach(path => {
      let current = path.parentPath;
      while (current && !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(current.node.type)) {
        current = current.parentPath;
      }
      if (current && !current.node.async) {
        current.node.async = true;
        madeChanges = true;
      }
    });
  }

  return root.toSource();
};
