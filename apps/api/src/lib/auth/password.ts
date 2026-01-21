import * as argon2 from "argon2";

/**
 * Argon2id configuration matching the previous oslo/password settings.
 * These values provide a good balance of security and performance.
 */
const ARGON2_OPTIONS: argon2.Options = {
	type: argon2.argon2id,
	memoryCost: 19456, // 19 MiB
	timeCost: 2, // iterations
	parallelism: 1,
};

export const hashPassword = async (password: string): Promise<string> => {
	return argon2.hash(password, ARGON2_OPTIONS);
};

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
	try {
		return await argon2.verify(hash, password);
	} catch {
		// Invalid hash format or other verification error
		return false;
	}
};
