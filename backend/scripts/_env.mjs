export function requireEnv(...names) {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim();
    if (value) return value;
  }
  throw new Error(
    `missing ${names.join(' / ')} — set it in backend/.env (see .env.example) before running this script`,
  );
}
