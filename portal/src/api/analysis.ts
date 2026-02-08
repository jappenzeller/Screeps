import { apiFetch } from './client';
import type {
  Recommendation,
  SignalResponse,
  SignalEventResponse,
  ObservationResponse,
  PatternResponse,
  FeedbackPayload,
} from '../types/analysis';

export function fetchRecommendations(roomName: string) {
  return apiFetch<Recommendation[]>(`/analysis/${roomName}/recommendations`);
}

export function fetchSignals(roomName: string, hours: number = 24) {
  return apiFetch<SignalResponse>(`/analysis/${roomName}/signals?hours=${hours}`);
}

export function fetchSignalEvents(roomName: string, hours: number = 24) {
  return apiFetch<SignalEventResponse>(`/analysis/${roomName}/signals/events?hours=${hours}`);
}

export function fetchObservations(roomName: string, limit: number = 10) {
  return apiFetch<ObservationResponse>(`/analysis/${roomName}/observations?limit=${limit}`);
}

export function fetchPatterns(roomName: string) {
  return apiFetch<PatternResponse>(`/analysis/${roomName}/patterns`);
}

export function submitFeedback(roomName: string, recommendationId: string, feedback: FeedbackPayload) {
  return apiFetch<{ success: boolean }>(`/analysis/${roomName}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ recommendationId, ...feedback }),
  });
}
