// Contract construction is independent of the desktop database and project state.
function createContract(variables, language) {
  const type = dataType => {
    if (language === 'smv') {
      if (dataType === 'boolean') return 'boolean';
      if (dataType.includes('int')) return 'integer';
    } else if (language === 'r2u2') {
      if (dataType === 'boolean') return 'bool';
      if (dataType === 'integer') return 'int';
      if (dataType === 'double') return 'float';
    } else {
      if (dataType === 'boolean') return 'bool';
      if (dataType.includes('int')) return 'int';
      if (dataType === 'double' || dataType === 'single') return 'real';
    }
    throw new TypeError(`Unsupported ${language || 'Lustre'} variable type: ${dataType}`);
  };
  const contract = {
    componentName: '', outputVariables: [], inputVariables: [], internalVariables: [],
    functions: [], assignments: [], copilotAssignments: [], r2u2Assignments: [],
    smvAssignments: [], modes: [], properties: []
  };
  for (const doc of variables) {
    const variable = { name: doc.variable_name };
    if (doc.idType === 'Function') {
      contract.functions.push({ ...variable, moduleName: doc.moduleName });
      continue;
    }
    variable.type = type(doc.dataType);
    if (doc.idType === 'Input') contract.inputVariables.push(variable);
    else if (doc.idType === 'Output') contract.outputVariables.push(variable);
    else if (doc.idType === 'Internal') {
      contract.internalVariables.push(variable);
      contract.assignments.push(doc.assignment);
      contract.copilotAssignments.push(doc.copilotAssignment);
      contract.r2u2Assignments.push(doc.r2u2Assignment);
      contract.smvAssignments.push(doc.smvAssignment);
    } else if (doc.idType === 'Mode') {
      contract.modes.push({ ...variable, ...(doc.modeRequirement ? { assignment: doc.modeRequirement } : {}) });
    } else throw new TypeError(`Unsupported variable role: ${doc.idType}`);
  }
  return contract;
}

module.exports = { createContract };
