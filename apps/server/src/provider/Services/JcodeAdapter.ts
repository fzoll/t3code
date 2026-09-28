/**
 * JcodeAdapter — shape type for the jcode provider adapter.
 *
 * @module JcodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface JcodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
