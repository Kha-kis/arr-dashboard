import { Argon2id } from "oslo/password";

const argon2id = new Argon2id({
  memorySize: 19456,
  iterations: 2,
  parallelism: 1,
});

export const hashPassword = async (password: string): Promise<string> => {
  return argon2id.hash(password);
};

export const verifyPassword = async (
  password: string,
  hash: string,
): Promise<boolean> => {
  return argon2id.verify(hash, password);
};
