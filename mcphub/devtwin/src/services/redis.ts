/** Redis service detector. */

import { ServiceDetector } from './base.js';

export class RedisDetector extends ServiceDetector {
  readonly name = 'redis';
  readonly defaultPort = 6379;
  override readonly envVarPatterns = ['^REDIS', '^CACHE_URL$'];
  override readonly dependencyNames = ['redis', 'ioredis', 'django-redis'];
  override readonly composeImageHints = ['redis'];
  override readonly readmeKeywords = ['redis'];
}
