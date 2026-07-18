# Valuation Method Protocol

Research OS separates valuation-method design from valuation execution. An AI
model may select a registered method, compose approved primitives, or propose a
new method. It cannot execute arbitrary generated code inside the research
pipeline.

## Method lifecycle

Methods use one of three origins:

- `registered`: a maintained Research OS method.
- `composed`: a new arrangement of supported formula primitives.
- `proposed`: a model-designed method that has not been promoted to the global
  registry.

A composed or proposed method can satisfy a profile-required model by listing
that model in `replaces_method_keys`. This does not silently register the new
method. The exact specification, input manifest, formula results, validation
result, scenarios, and tables are stored on the run's `valuation_model_runs`
record.

## Execution contract

The protocol accepts an ordered JSON formula graph. Supported operations are:

`add`, `subtract`, `multiply`, `divide`, `sum`, `average`, `min`, `max`,
`negate`, `abs`, `power`, `discount`, `terminal_growth`, and `clamp`.

Formula arguments may contain only finite numeric constants, declared input
keys, or earlier formula keys. JavaScript, Python, SQL, expression strings,
network access, and filesystem access are not accepted.

Every method must define:

- observed metric, explicit assumption, and constant inputs;
- ordered formulas and a numeric `per_share_value` output;
- bull, base, and bear scenarios whose probabilities total one;
- at least one reproducible numeric table;
- limitations and the rationale for the selected framework.

Metric inputs resolve only against accepted canonical metric observations.
Their observation and evidence IDs are retained. Missing data may be supplied
only as an explicitly labeled numeric assumption with rationale; it may not be
presented as an observed metric.

## Validation and repair

Research OS independently validates and evaluates a proposal. It checks schema
conformance, reference ordering, operation arity, finite results, scenario
coverage and ordering, probability totals, table references, and required-model
coverage.

An invalid initial proposal receives one bounded semantic repair containing the
validation errors and a capped excerpt of the previous output. If the repaired
proposal is still invalid, the valuation model remains `blocked`, the workflow
records a source gap, and human review remains unavailable.

Validated scenario rows are linked to their executable `valuation_model_run_id`.
Narrative price targets returned by a model remain unlinked and cannot satisfy
the Research OS v2 executable-valuation quality gate.
