import { safeRun } from './exec.ts';

export function isValidOtp(code: string): boolean {
  return /^\d{6,8}$/.test(code);
}

const CANDIDATE_NAMES = ['npmjs.com', 'npm', 'npmjs'];

export function fetchNpmOtp(): string | null {
  const tryCommand = (cmd: string): string | null => {
    const res = safeRun(cmd);
    if (!res.ok) return null;
    const code = res.out.trim();
    return isValidOtp(code) ? code : null;
  };

  // 1. Explicit override
  const override = process.env['NPM_OTP_COMMAND'];
  if (override) {
    const code = tryCommand(override);
    if (code) {
      console.log('🔑 Using OTP from NPM_OTP_COMMAND.');
      return code;
    }
    console.log('⚠️  NPM_OTP_COMMAND did not produce a valid OTP; falling back.');
  }

  // 2. 1Password CLI
  if (safeRun('command -v op').ok) {
    for (const name of CANDIDATE_NAMES) {
      const code = tryCommand(`op item get '${name}' --otp`);
      if (code) {
        console.log(`🔑 Fetched OTP from 1Password item "${name}".`);
        return code;
      }
    }
  }

  // 3. LastPass CLI
  if (safeRun('command -v lpass').ok) {
    for (const name of CANDIDATE_NAMES) {
      const code = tryCommand(`lpass show --totp '${name}'`);
      if (code) {
        console.log(`🔑 Fetched OTP from LastPass item "${name}".`);
        return code;
      }
    }
  }

  return null;
}
