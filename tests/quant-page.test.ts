// Runs the quant-page acceptance tests (fundamentals, PragValue and PragTrend parity, API, page) in `npm run test:unit`.
import "../Implementations/quant-page/acceptance/p1-inputs.test";
import "../Implementations/quant-page/acceptance/p2-value.test";
import "../Implementations/quant-page/acceptance/p2c-fuzz.test";
import "../Implementations/quant-page/acceptance/p3-trend.test";
import "../Implementations/quant-page/acceptance/p4-api.test";
import "../Implementations/quant-page/acceptance/p4b-api-review.test";
import "../Implementations/quant-page/acceptance/p5-page.test";
import "../Implementations/quant-page/acceptance/p5b-page-review.test";
