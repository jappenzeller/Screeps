import { apiFetch } from './client';
import type { MilitaryStatus, CampaignDetail } from '../types/military';

export function fetchMilitaryStatus() {
  return apiFetch<MilitaryStatus>('/military');
}

export function fetchCampaign(campaignId: string) {
  return apiFetch<CampaignDetail>(`/military/${campaignId}`);
}
