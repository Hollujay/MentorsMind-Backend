/**
 * Elasticsearch Performance Tuning Configuration
 * Optimizes search performance and relevance scoring
 */

export interface ElasticsearchTuningConfig {
  // Performance settings
  maxResultWindow: number;
  batchSize: number;
  scrollTimeout: string;
  refreshInterval: string;
  
  // Relevance scoring
  minimumShouldMatch: string;
  tieBreaker: number;
  boost: {
    title: number;
    content: number;
    tags: number;
  };
  
  // Advanced features
  enableFuzzySearch: boolean;
  fuzziness: string;
  prefixLength: number;
  enableHighlighting: boolean;
  
  // Indexing optimization
  numberOfShards: number;
  numberOfReplicas: number;
  bulkIndexSize: number;
}

export const defaultElasticsearchConfig: ElasticsearchTuningConfig = {
  maxResultWindow: 10000,
  batchSize: 100,
  scrollTimeout: '1m',
  refreshInterval: '1s',
  
  minimumShouldMatch: '75%',
  tieBreaker: 0.3,
  boost: {
    title: 3.0,
    content: 1.0,
    tags: 2.0,
  },
  
  enableFuzzySearch: true,
  fuzziness: 'AUTO',
  prefixLength: 2,
  enableHighlighting: true,
  
  numberOfShards: 5,
  numberOfReplicas: 1,
  bulkIndexSize: 500,
};
