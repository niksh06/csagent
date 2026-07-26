/**
 * `irida doctor` — validate the minimum needed for a local SDK run
 * (issue 004). Never prints secret values.
 */
import { warmCredentialsCache } from "./credentials.js";
import { warmGatewayAllowlistCache } from "./gatewayAllowlist.js";
import {
  gatherDoctorChecks,
  gatherDoctorApiChecks,
  gatherDoctorStoreChecks,
  gatherDoctorEmbedderChecks,
  gatherDoctorTelegramChecks,
  doctorAllOk,
  type ModelsListFn,
} from "./doctorChecks.js";

export { cmdDoctorMorningAlert } from "./doctorCronAlert.js";

export async function cmdDoctor(
  dir: string = process.cwd(),
  opts?: { listModels?: ModelsListFn }
): Promise<number> {
  await warmCredentialsCache(dir);
  await warmGatewayAllowlistCache(dir);
  const checks = [
    ...gatherDoctorChecks(dir),
    ...(await gatherDoctorStoreChecks(dir)),
    ...(await gatherDoctorEmbedderChecks(dir)),
    ...(await gatherDoctorTelegramChecks(dir)),
    ...(await gatherDoctorApiChecks(dir, opts)),
  ];
  for (const c of checks) {
    console.log(`${c.ok ? "OK  " : "FAIL"}  ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) {
      console.log(`      ↳ fix: ${c.fix}`);
    }
  }
  const allOk = doctorAllOk(checks);
  console.log(allOk ? "\ndoctor: all checks passed" : "\ndoctor: some checks failed");
  return allOk ? 0 : 1;
}

export { gatherDoctorChecks, gatherDoctorApiChecks, gatherDoctorStoreChecks, gatherDoctorEmbedderChecks, gatherDoctorTelegramChecks, doctorAllOk };
