import { describe, it, expect } from 'vitest';
import { parseAwsCredentialsIni, resolveAwsCredentials } from './awsCredentials.js';

const INI = `
[default]
aws_access_key_id = AKIA_DEFAULT
aws_secret_access_key = secret_default

[profile work]
aws_access_key_id = AKIA_WORK
aws_secret_access_key = secret_work
aws_session_token = tok_work  ; inline comment
`;

describe('parseAwsCredentialsIni', () => {
  it('parses the default profile', () => {
    expect(parseAwsCredentialsIni(INI, 'default')).toEqual({
      aws_access_key_id: 'AKIA_DEFAULT',
      aws_secret_access_key: 'secret_default',
    });
  });

  it('parses a named profile, stripping the "profile " prefix and comments', () => {
    expect(parseAwsCredentialsIni(INI, 'work')).toEqual({
      aws_access_key_id: 'AKIA_WORK',
      aws_secret_access_key: 'secret_work',
      aws_session_token: 'tok_work',
    });
  });

  it('returns null for an unknown profile', () => {
    expect(parseAwsCredentialsIni(INI, 'nope')).toBeNull();
  });
});

describe('resolveAwsCredentials', () => {
  it('prefers environment variables', () => {
    const creds = resolveAwsCredentials(
      { AWS_ACCESS_KEY_ID: 'ENV_KEY', AWS_SECRET_ACCESS_KEY: 'ENV_SECRET', AWS_SESSION_TOKEN: 'ENV_TOK' },
      '/nonexistent/credentials',
    );
    expect(creds).toEqual({ accessKeyId: 'ENV_KEY', secretAccessKey: 'ENV_SECRET', sessionToken: 'ENV_TOK' });
  });

  it('returns null when there are no env vars and no credentials file', () => {
    expect(resolveAwsCredentials({}, '/nonexistent/credentials')).toBeNull();
  });
});

// #112: AWS_SHARED_CREDENTIALS_FILE (the AWS CLI/SDK override) was ignored.
describe('AWS_SHARED_CREDENTIALS_FILE', () => {
  it('reads the credentials file it names', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-aws-')), 'creds');
    fs.writeFileSync(file, '[default]\naws_access_key_id = AKIDFROMFILE\naws_secret_access_key = s3cr3t\n');
    const creds = resolveAwsCredentials({ AWS_SHARED_CREDENTIALS_FILE: file } as NodeJS.ProcessEnv);
    expect(creds?.accessKeyId).toBe('AKIDFROMFILE');
  });
});
