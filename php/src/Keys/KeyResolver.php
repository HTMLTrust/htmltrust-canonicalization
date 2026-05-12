<?php
/**
 * Pluggable keyid resolution per HTMLTrust spec §2.2. Implementations cover
 * decentralized identifiers (did:web:...), direct-URL public keys, and
 * trust-directory lookups. Verifiers compose a chain of resolvers; the
 * first that recognizes a keyid wins.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

interface KeyResolver
{
    /**
     * Cheap pre-check: can this resolver plausibly handle the given keyid?
     * Used to short-circuit the chain so a 404 from one resolver doesn't
     * force a network call to the next.
     */
    public function supports(string $keyid): bool;

    /**
     * Attempt to resolve `$keyid` to a public key. Return null if the
     * resolver cannot resolve this keyid (e.g. network failure, key not
     * found). MUST NOT throw for ordinary "not found" cases — return null.
     */
    public function resolve(string $keyid): ?ResolvedKey;
}
