import type { ReportDocument } from './report';
import { ReportVisual, validateVisual, type VisualSpec } from './visuals';

// A reviewed presentation supplement for this exact legacy report, not a company-name heuristic.
export const TRIAL_REPORT_HASH = '61ac57651a58c24ba3214a5d4f2a87e0d56444350899a1893ce5885869d71b3e';
export const SOFI_VISUAL_TRIAL: Record<string, VisualSpec[]> = {
  business_processes_customer_decisions: [{kind:'process',title:'How cash moves through the business',caption:'Simplified business model. Deposits support lending; loan sales and technology services create other routes to cash and revenue.',lanes:[
    {nodes:[{label:'Depositors',icon:'people'},{label:'SoFi Bank',icon:'bank'},{label:'Loans held',icon:'document'},{label:'Interest income',icon:'chart'}],note:'Interest income less funding interest expense gives net interest income. Credit losses and operating costs affect profit.',relationship:'documented',evidence_ids:['39e34214-f46d-40d7-87bd-f402dc526c2f'],artifact_ids:['2d2b12d6-989c-4fb0-b17d-dff52b0b0de1']},
    {nodes:[{label:'Loan origination',icon:'document'},{label:'Loan buyers',icon:'people'},{label:'Fees / sale proceeds',icon:'chart'}],note:'Underwriting, capital and buyer demand constrain volume. Sale proceeds are cash receipts, not all revenue.',relationship:'documented',evidence_ids:['2dfaa46c-6018-402b-bfd7-2e383ccc8187'],artifact_ids:['2d2b12d6-989c-4fb0-b17d-dff52b0b0de1']},
    {nodes:[{label:'Enterprise clients',icon:'building'},{label:'Galileo / Technisys',icon:'technology'},{label:'Technology revenue',icon:'settings'}],note:'Technology services to financial institutions and fintechs. Exact pricing and contract terms are not disclosed.',relationship:'documented',evidence_ids:['67bb8c8d-3a82-4598-a0b4-1fffdc12b54a'],artifact_ids:['da871b3b-2148-49ba-b4db-310c6da53aca']},
  ]}],
  funding_liquidity_capital_constraints:[{kind:'history',title:'The deposit funding base',caption:'Stored quarterly observations. Growth in balances does not establish low funding costs or stable deposits.',artifact_id:'775bd945-a2a6-4f98-9c37-80b08f3d8370',path:'observations',metric_key:'deposits',unit:'USD',currency:'USD',reporting_basis:'gaap',periodicity:'quarterly'}],
};

export function sectionVisuals(document: ReportDocument, sectionId: string): VisualSpec[] {
  const supplied = document.sections.find(s=>s.id===sectionId)?.visuals;
  const candidate = supplied ?? (document.content_hash === TRIAL_REPORT_HASH ? SOFI_VISUAL_TRIAL[sectionId] : []) ?? [];
  return candidate.flatMap(value => {
    try { const visual=ReportVisual.parse(value); validateVisual(visual,document); return [visual]; }
    catch { return []; } // A malformed optional figure must not hide the underlying report.
  });
}
