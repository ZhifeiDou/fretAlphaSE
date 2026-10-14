// Copyright © 2025, United States Government, as represented by the Administrator of the National Aeronautics and Space Administration. All rights reserved.
// 
// The “FRET : Formal Requirements Elicitation Tool - Version 3.0” software is licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 
// 
// Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
// Component-level diagnosis using delta debugging and a hitting-set tree.
// All solver and filesystem dependencies belong to the caller's execution.
const fs = require('fs');
const path = require('path');
const HSNode = require('./HSNode.js');

class DiagnosisEngine {
  constructor(contract, engineName, engineOptions, execution) {
    this.contract = JSON.parse(JSON.stringify(contract));
    this.engineName = engineName;
    this.engineOptions = engineOptions;
    this.execution = execution;
    this.results = new Map();
    this.conflicts = new Map();
    this.queryIndex = 0;
  }

  key(ids) { return JSON.stringify([...ids].sort()); }

  async query(ids) {
    const key = this.key(ids);
    if (this.results.has(key)) return this.results.get(key);
    const contract = JSON.parse(JSON.stringify(this.contract));
    contract.properties = contract.properties.filter(p => p.kind === 'assumption' || ids.includes(p.reqid));
    contract.componentName += '_diagnosticQuery_' + this.queryIndex++ + 'Spec';
    const filePath = path.join(this.execution.workDirectory, contract.componentName + '.lus');
    fs.writeFileSync(filePath, this.execution.renderContract(contract), 'utf8');
    const output = await this.execution.checkContract(filePath, this.engineName, this.engineOptions);
    if (output.result === 'UNKNOWN') {
      const error = new Error('Diagnosis returned UNKNOWN for requirements: ' + ids.join(', '));
      error.code = 'analysis_unknown';
      throw error;
    }
    if (!['REALIZABLE', 'UNREALIZABLE'].includes(output.result)) {
      throw new Error(output.error || 'Unexpected diagnosis backend result.');
    }
    this.results.set(key, output);
    return output;
  }

  // The caller has established that ids is unrealizable. Reduce it to an
  // inclusion-minimal conflict while keeping every environment assumption.
  async deltaDebug(ids) {
    let remaining = [...ids];
    let granularity = 2;
    while (remaining.length > 1) {
      granularity = Math.min(granularity, remaining.length);
      const parts = Array.from({ length: granularity }, (_, i) =>
        remaining.slice(Math.floor(i * remaining.length / granularity), Math.floor((i + 1) * remaining.length / granularity)));
      const candidates = granularity === 2 ? parts : [
        ...parts, ...parts.map(part => remaining.filter(id => !part.includes(id)))
      ];
      let reduced = false;
      for (const candidate of candidates) {
        if ((await this.query(candidate)).result === 'UNREALIZABLE') {
          remaining = candidate;
          granularity = Math.max(2, granularity - 1);
          reduced = true;
          break;
        }
      }
      if (reduced) continue;
      if (granularity === remaining.length) break;
      granularity = Math.min(remaining.length, granularity * 2);
    }
    return remaining;
  }

  // Keep the desktop trace contract while retaining the exact backend output.
  // Rational values stay exact instead of being rounded to JavaScript floats.
  combineReports() {
    const report = { Requirements: this.contract.properties.map(p => p.reqid), Conflicts: [], Counterexamples: [] };
    for (const ids of this.conflicts.values()) {
      const output = this.results.get(this.key(ids));
      let traceLength = 0;
      let counterexample = [];
      if (this.engineName === 'kind2') {
        const trace = output.jsonOutput?.find(item => item.objectType === 'realizabilityCheck' && item.result === 'unrealizable')?.deadlockingTrace?.[0];
        counterexample = (trace?.streams || []).map(stream => {
          const row = { name: stream.name, type: stream.type };
          for (const [step, value] of stream.instantValues) {
            traceLength = Math.max(traceLength, step + 1);
            row['Step ' + step] = typeof value === 'object' ? JSON.stringify(value) : value;
          }
          return row;
        });
      } else {
        traceLength = output.jsonOutput?.K ?? 0;
        counterexample = output.jsonOutput?.Counterexample ?? [];
      }
      report.Conflicts.push({ Conflict: ids });
      report.Counterexamples.push({ requirements: ids, traceLength,
        Counterexample: counterexample, backendOutput: output.jsonOutput });
    }
    return report;
  }

  async main() {
    const guarantees = this.contract.properties.filter(p => p.kind !== 'assumption').map(p => p.reqid);
    if (!guarantees.length) throw new Error('Diagnosis requires a guarantee.');
    try {
      if ((await this.query(guarantees)).result === 'REALIZABLE') {
        return [null, ['REALIZABLE', this.combineReports()]];
      }
      const pending = [new HSNode(null, null)];
      const visited = new Set();
      // A path removes at least one member of each conflict on that path.
      // A realizable remainder is a leaf; an unrealizable one adds a new
      // conflict. Canonical set keys prevent ambiguous IDs and duplicate work.
      for (let index = 0; index < pending.length; index++) {
        const node = pending[index];
        const removed = node.getHittingSet();
        const key = this.key(removed);
        if (visited.has(key)) continue;
        visited.add(key);
        const remaining = guarantees.filter(id => !removed.includes(id));
        if (!remaining.length) continue;
        let conflict = [...this.conflicts.values()].find(ids => ids.every(id => !removed.includes(id)));
        if (!conflict) {
          if ((await this.query(remaining)).result === 'REALIZABLE') continue;
          conflict = await this.deltaDebug(remaining);
          this.conflicts.set(this.key(conflict), conflict);
        }
        node.setLabel(conflict);
        pending.push(...node.getChildren());
      }
      return [null, ['UNREALIZABLE', this.combineReports()]];
    } catch (error) {
      if (error.code === 'analysis_unknown') return [error.message, null];
      throw error;
    }
  }
}

module.exports = DiagnosisEngine;
