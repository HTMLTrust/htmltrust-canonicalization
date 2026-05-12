<?php
/**
 * Top-level resolveKey() helper. Walks a chain of KeyResolvers and returns
 * the first successful resolution. Per spec §2.2, no resolution method is
 * privileged: implementations accept multiple methods and verifiers compose
 * the chain according to local policy.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class KeyResolution
{
    /**
     * @param string $keyid
     * @param array<int, KeyResolver> $resolvers
     */
    public static function resolveKey(string $keyid, array $resolvers): ?ResolvedKey
    {
        if ($keyid === '') {
            return null;
        }
        foreach ($resolvers as $resolver) {
            if (!$resolver instanceof KeyResolver) {
                continue;
            }
            if (!$resolver->supports($keyid)) {
                continue;
            }
            $resolved = $resolver->resolve($keyid);
            if ($resolved !== null) {
                return $resolved;
            }
        }
        return null;
    }
}
