// Runs the pragma-xbrl-merge acceptance tests (XBRL warehouse client, stock rating, wiring) in `npm run test:unit`.
// The verification set stays separate: npx tsx --test Implementations/pragma-xbrl-merge/verification/*.test.ts*
import "../Implementations/pragma-xbrl-merge/acceptance/p1-warehouse-import.test";
import "../Implementations/pragma-xbrl-merge/acceptance/p2-warehouse-facts.test";
import "../Implementations/pragma-xbrl-merge/acceptance/p2b-real-shapes.test";
import "../Implementations/pragma-xbrl-merge/acceptance/p3-rating.test";
import "../Implementations/pragma-xbrl-merge/acceptance/p4-wiring.test";
import "../Implementations/pragma-xbrl-merge/acceptance/p4b-model-hidden.test";
