"""Materialize explicitly reviewed correction candidates; no formula rewriting."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "mcp/tests/fixtures"
originals = json.loads((FIXTURES / "historical-failed-models.json").read_text(encoding="utf-8"))

# Complete replacement clauses are deliberately enumerated. These are proposed
# source-level syntax/type corrections, not a runtime repair mechanism.
edits = {
    "SRS-12-01:absence_result": (
        "WrapperRetrieval shall always satisfy (returned_none <-> !has_wrapper).",
        "Express the intended Boolean equality with FRET's equivalence operator; preserve both directions of the absence relation."),
    "SRS-9-01:zero_repeat_probability": (
        "whenever repeat_probability = 0.0 StickyActionEnv shall satisfy executed_action = intended_action.",
        "Place the condition before the component and spell zero as a real literal for the unchanged real probability declaration; preserve the zero-probability endpoint."),
    "SRS-9-01:certain_repeat_probability": (
        "whenever repeat_probability = 1.0 StickyActionEnv shall satisfy executed_action = previous_action.",
        "Place the condition before the component and spell one as a real literal; preserve the certainty endpoint."),
    "SRS-10-08:remaining_fraction": (
        "whenever total > 0.0 TrainingProgress shall immediately satisfy remaining = 1.0 - current / total.",
        "Both comparison zero and subtraction one must be real literals because total/current/remaining are declared real. Preserve the complete division relation and positive-total guard."),
    "SRS-13-03:lifecycle_dispatch": (
        "CallbackLifecycle shall always satisfy (lifecycle_event => hook_called).",
        "Use FRET's implication token for the same one-way dispatch obligation."),
    "SRS-13-06:trigger_child": (
        "EventComposition shall always satisfy ((child_present & event_dispatch) => child_called).",
        "Use FRET conjunction and implication tokens without changing the conjunction or its consequent."),
    "SRS-13-06:return_child": (
        "EventComposition shall always satisfy ((child_present & event_dispatch) => (event_result = child_result)).",
        "Use FRET conjunction and implication tokens; retain the Boolean result equality."),
    "SRS-13-07:any_false_stops": (
        "ListComposition shall always satisfy ((list_step & any_child_false) => !list_result).",
        "Use FRET conjunction and implication tokens; retain the negative list-result obligation."),
    "SRS-18-11:clear_counters": (
        "VecMonitorReset shall always satisfy ((episode_return = 0.0) & (episode_length = 0)).",
        "Only episode_return is real; its zero becomes 0.0 while the integer episode_length and its zero remain unchanged."),
    "SRS-18-19:strict_cutoff": (
        "ResultsFilter shall always satisfy (cutoff_supplied => (passes_timestep_filter <-> (point_timesteps < cutoff))).",
        "Use Boolean equivalence to compare the predicate with the integer comparison; preserve the strict less-than cutoff and both truth directions."),
    "SRS-23-04:combined_moments": (
        "whenever moments_return & (old_count + batch_count != 0.0) RunningMeanStdMoments shall immediately satisfy new_mean = old_mean + (batch_mean - old_mean) * batch_count / (old_count + batch_count) & new_variance = (old_count * old_variance + batch_count * batch_variance + (batch_mean - old_mean) * (batch_mean - old_mean) * old_count * batch_count / (old_count + batch_count)) / (old_count + batch_count).",
        "Use real zero in the real-valued sum guard; retain the full nonlinear mean/variance equations and unchanged real count abstraction."),
    "SRS-23-03:combined_moments": (
        "whenever update_return & (old_count + batch_count != 0.0) RunningMeanStdUpdate shall immediately satisfy new_mean = old_mean + (batch_mean - old_mean) * batch_count / (old_count + batch_count) & new_variance = (old_count * old_variance + batch_count * batch_variance + (batch_mean - old_mean) * (batch_mean - old_mean) * old_count * batch_count / (old_count + batch_count)) / (old_count + batch_count).",
        "Use real zero in the real-valued sum guard; retain the full nonlinear mean/variance equations and unchanged real count abstraction."),
    "SRS-23-05:combined_moments": (
        "whenever combine_return & (own_count + other_count != 0.0) RunningMeanStdCombine shall immediately satisfy combined_mean = own_mean + (other_mean - own_mean) * other_count / (own_count + other_count) & combined_variance = (own_count * own_variance + other_count * other_variance + (other_mean - own_mean) * (other_mean - own_mean) * own_count * other_count / (own_count + other_count)) / (own_count + other_count).",
        "Use real zero in the real-valued sum guard; retain the full nonlinear merge equations and unchanged real count abstraction."),
    "SRS-23-08:ones_initialization": (
        "whenever initializing_squared_average RMSpropTFLikeNumerics shall immediately satisfy squared_average_initial = 1.0.",
        "The initialized squared average is real, so use real one without changing its value."),
    "SRS-23-08:squared_gradient_update": (
        "whenever step_return RMSpropTFLikeNumerics shall immediately satisfy effective_gradient = raw_gradient + weight_decay * old_parameter & squared_average = alpha * old_squared_average + (1.0 - alpha) * effective_gradient * effective_gradient.",
        "Use real one in the real alpha subtraction; preserve both weight-decay and full squared-gradient update equations."),
    "SRS-23-08:gradient_average_update": (
        "whenever step_return & centered RMSpropTFLikeNumerics shall immediately satisfy gradient_average = alpha * old_gradient_average + (1.0 - alpha) * effective_gradient.",
        "Use real one in the real alpha subtraction; preserve the centering guard and update equation."),
    "SRS-23-08:uncentered_denominator": (
        "whenever step_return & !centered & (squared_average + eps >= 0.0) RMSpropTFLikeNumerics shall immediately satisfy denominator >= 0.0 & denominator * denominator = squared_average + eps.",
        "Use real zeros in both real comparisons; retain the nonnegative square-root relation and original domain guard."),
    "SRS-23-08:centered_denominator": (
        "whenever step_return & centered & (squared_average - gradient_average * gradient_average + eps >= 0.0) RMSpropTFLikeNumerics shall immediately satisfy denominator >= 0.0 & denominator * denominator = squared_average - gradient_average * gradient_average + eps.",
        "Use real zeros in both real comparisons; retain the centered nonnegative square-root relation and original domain guard."),
    "SRS-23-08:plain_parameter_update": (
        "whenever step_return & (denominator > 0.0) & (momentum = 0.0) RMSpropTFLikeNumerics shall immediately satisfy new_parameter = old_parameter - lr * effective_gradient / denominator.",
        "Use real zeros for denominator and momentum comparisons; retain the complete plain parameter update and positive-denominator guard."),
    "SRS-23-08:momentum_parameter_update": (
        "whenever step_return & (denominator > 0.0) & (momentum != 0.0) RMSpropTFLikeNumerics shall immediately satisfy new_buffer = momentum * old_buffer + effective_gradient / denominator & new_parameter = old_parameter - lr * new_buffer.",
        "Use real zeros for denominator and momentum comparisons; retain both momentum-buffer and parameter equations."),
    "SRS-25-03:dtype_check_selection": (
        "whenever true NatureExtractor shall immediately satisfy (dtype_checked <-> !normalized_image)",
        "Express the intended Boolean equality with equivalence; preserve the normalized-image flag polarity."),
    "SRS-25-03:bounds_check_selection": (
        "whenever true NatureExtractor shall immediately satisfy (bounds_checked <-> !normalized_image)",
        "Express the intended Boolean equality with equivalence; preserve the normalized-image flag polarity."),
    "SRS-25-05:dtype_check_selection": (
        "whenever true CombinedExtractorConfiguration shall immediately satisfy (dtype_checked <-> !normalized_image)",
        "Express the intended Boolean equality with equivalence; preserve the normalized-image flag polarity."),
    "SRS-25-05:bounds_check_selection": (
        "whenever true CombinedExtractorConfiguration shall immediately satisfy (bounds_checked <-> !normalized_image)",
        "Express the intended Boolean equality with equivalence; preserve the normalized-image flag polarity."),
    "SRS-28-03:copy_requested_info": (
        "whenever addition_completed & copy_info HerStorage shall immediately satisfy info_stored.",
        "Place the same conjunction before the component as required by FRET grammar; retain the storage guarantee and immediate timing."),
    "SRS-28-07:future_goal": (
        "whenever strategy_code = 0 HerGoals shall immediately satisfy same_episode & selected_step > current_step.",
        "Place the condition before the component; retain strategy 0 and the strictly-future relation without adding episode bounds."),
    "SRS-28-07:final_goal": (
        "whenever strategy_code = 1 HerGoals shall immediately satisfy same_episode & selected_step = last_step.",
        "Place the condition before the component; retain strategy 1 and final-step equality."),
    "SRS-28-07:episode_goal": (
        "whenever strategy_code = 2 HerGoals shall immediately satisfy same_episode.",
        "Place the condition before the component; retain strategy 2 and same-episode guarantee."),
}

gaps = {
    "WrapperRetrieval": ["The Bool abstraction only captures result absence; wrapper identity, traversal order, termination, and implementation observations remain outside it."],
    "StickyActionEnv": ["This retains allowed actions and the probability-0/1 endpoints, not intermediate probability distribution or sampling independence.", "previous_action is an independent input snapshot; cross-step history binding and the probability input domain are not established by this model."],
    "TrainingProgress": ["This retains the complete guarded arithmetic relation over Reals, not merely endpoint behavior.", "The model does not establish integral timesteps, input domain beyond the existing positive-total guard, call completion, or actual implementation observations."],
    "CallbackLifecycle": ["The aggregate event/hook booleans do not distinguish each lifecycle hook's identity, order, arguments, or actual invocation."],
    "EventComposition": ["The abstraction retains dispatch and Boolean child-result forwarding, not object identity, actual child invocation, arguments, or ordering."],
    "ListComposition": ["The aggregate any_child_false predicate must be independently observed; member ordering, invoking every member, and the all-true return case are not specified by this single implication."],
    "VecMonitorReset": ["The snapshot model only checks cleared scalar counters for an arbitrary environment; it does not model vector shape, every environment, call termination, or subsequent accumulation."],
    "ResultsFilter": ["The arbitrary-point model retains strict cutoff eligibility and no-cutoff behavior; it does not model collection ordering, complete point enumeration, or plotting effects."],
    "RunningMeanStdMoments": ["The complete nonlinear scalar moment relations are retained; backend support/termination must be measured rather than assumed.", "Real count snapshots do not prove integer/nonnegative counts; vector shape, previous-state binding, floating-point error, and actual observations remain outside this model."],
    "RunningMeanStdUpdate": ["The complete nonlinear scalar moment relations are retained; backend support/termination must be measured rather than assumed.", "Input moments must be independently derived from the supplied batch. Real count snapshots do not prove integer counts; batch arrays, vector shape, previous-state binding and floating-point error remain outside this model."],
    "RunningMeanStdCombine": ["The complete nonlinear scalar merge relations are retained; backend support/termination must be measured rather than assumed.", "Real count snapshots do not prove integer/nonnegative counts; vector shape, independent other-state binding, floating-point error, and actual observations remain outside this model."],
    "RMSpropTFLikeNumerics": ["All nine clauses, nonlinear products/divisions, square-root characterization, and guards are retained; backend support/termination is not assumed.", "Configured input domains and previous-state bindings are unchanged and may admit nonphysical values. Tensor-wide behavior, closure identity, floating-point effects, and actual execution are not proved.", "Some original triggers reference output quantities; these guards are preserved for fidelity, and do not independently prove that positive denominators or valid radicands always arise."],
    "NatureExtractor": ["Dimensions and selected image checks are modeled, not convolution architecture, tensor values, image-domain validity, or implementation observations."],
    "CombinedExtractorConfiguration": ["The model treats one considered CNN; per-key extraction, concatenation order, total shape, and actual implementation remain outside it."],
    "HerStorage": ["The info_stored observation requires independent binding to copied input dictionaries; alias independence, all dictionary entries, and later compute_reward behavior are not established by a Bool flag alone."],
    "HerGoals": ["The strict future-step relation is preserved; finite episode bounds and whether a future step exists are not added as assumptions.", "Goal identity, sampling distribution, circular-buffer binding, and actual observations remain outside this integer/Bool abstraction."],
}

cases = []
used = set()
for case in originals["cases"]:
    corrected = copy.deepcopy(case["original"]["input"])
    changes = []
    for requirement in corrected["requirements"]:
        if requirement["id"] in edits:
            text, reason = edits[requirement["id"]]
            changes.append({"id": requirement["id"], "before": requirement["fretish"], "after": text, "rationale": reason})
            requirement["fretish"] = text
            used.add(requirement["id"])
    assert changes, case["component"]
    cases.append({
        "component": case["component"],
        "original_job_id": case["original"]["job_id"],
        "input": corrected,
        "changes": changes,
        "remaining_gaps": gaps[case["component"]],
    })
assert used == edits.keys()
(FIXTURES / "historical-corrected-models.json").write_text(json.dumps({
    "description": "Explicit correction candidates for the 16 archived failed inputs. Only enumerated FRETish clauses change; all IDs, source references, kinds, variable declarations, roles, meanings, time models, and solver options remain identical. These are not new archived jobs or evidence of source/implementation correctness.",
    "cases": cases,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(cases)} complete correction candidates with {len(used)} explicit clause edits.")
