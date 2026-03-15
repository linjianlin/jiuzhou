import type { AxiosRequestConfig } from 'axios';
import api from './core';
import type {
  CaptchaResponse,
  UnifiedCaptchaPayload,
} from './auth-character';
import type { PartnerDisplayDto } from './partner';

export type MarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'qtyDesc';

export interface MarketListingDto {
  id: number;
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  quality: string | null;
  category: string | null;
  subCategory: string | null;
  description: string | null;
  longDesc: string | null;
  tags: unknown;
  effectDefs: unknown;
  baseAttrs: Record<string, number>;
  equipSlot: string | null;
  equipReqRealm: string | null;
  useType: string | null;
  strengthenLevel: number;
  refineLevel: number;
  identified: boolean;
  affixes: unknown;
  socketedGems: unknown;
  generatedTechniqueId: string | null;
  qty: number;
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
}

export interface MarketListingsResponse {
  success: boolean;
  message: string;
  data?: { listings: MarketListingDto[]; total: number };
}

export interface MarketMyListingsResponse {
  success: boolean;
  message: string;
  data?: { listings: MarketListingDto[]; total: number };
}

export interface MarketTradeRecordDto {
  id: number;
  type: '买入' | '卖出';
  itemDefId: string;
  name: string;
  icon: string | null;
  qty: number;
  unitPriceSpiritStones: number;
  counterparty: string;
  time: number;
}

export interface MarketTradeRecordsResponse {
  success: boolean;
  message: string;
  data?: { records: MarketTradeRecordDto[]; total: number };
}

export type PartnerMarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'levelDesc';

export interface MarketPartnerListingDto {
  id: number;
  partner: PartnerDisplayDto;
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
}

export interface MarketPartnerListingsResponse {
  success: boolean;
  message: string;
  data?: { listings: MarketPartnerListingDto[]; total: number };
}

export interface MarketPartnerTradeRecordDto {
  id: number;
  type: '买入' | '卖出';
  partner: PartnerDisplayDto;
  unitPriceSpiritStones: number;
  totalPriceSpiritStones: number;
  counterparty: string;
  time: number;
}

export interface MarketPartnerTradeRecordsResponse {
  success: boolean;
  message: string;
  data?: { records: MarketPartnerTradeRecordDto[]; total: number };
}

export const getMarketListings = (params?: {
  category?: string;
  quality?: string;
  query?: string;
  sort?: MarketSort;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  pageSize?: number;
}): Promise<MarketListingsResponse> => {
  return api.get('/market/listings', { params });
};

export const getMyMarketListings = (params?: {
  status?: 'active' | 'sold' | 'cancelled';
  page?: number;
  pageSize?: number;
}): Promise<MarketMyListingsResponse> => {
  return api.get('/market/my-listings', { params });
};

export const createMarketListing = (body: {
  itemInstanceId: number;
  qty: number;
  unitPriceSpiritStones: number;
}): Promise<{ success: boolean; message: string; data?: { listingId: number } }> => {
  return api.post('/market/list', body);
};

export const cancelMarketListing = (listingId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/market/cancel', { listingId });
};

export const buyMarketListing = (
  listingId: number,
  qty: number = 1,
  requestConfig?: AxiosRequestConfig,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/market/buy', { listingId, qty }, requestConfig);
};

export const getMarketTradeRecords = (params?: {
  page?: number;
  pageSize?: number;
}): Promise<MarketTradeRecordsResponse> => {
  return api.get('/market/records', { params });
};

export const getPartnerMarketListings = (params?: {
  quality?: string;
  element?: string;
  query?: string;
  sort?: PartnerMarketSort;
  page?: number;
  pageSize?: number;
}): Promise<MarketPartnerListingsResponse> => {
  return api.get('/market/partner-listings', { params });
};

export const getMyPartnerMarketListings = (params?: {
  status?: 'active' | 'sold' | 'cancelled';
  page?: number;
  pageSize?: number;
}): Promise<MarketPartnerListingsResponse> => {
  return api.get('/market/partner-my-listings', { params });
};

export const createPartnerMarketListing = (body: {
  partnerId: number;
  unitPriceSpiritStones: number;
}): Promise<{ success: boolean; message: string; data?: { listingId: number } }> => {
  return api.post('/market/partner/list', body);
};

export const cancelPartnerMarketListing = (
  listingId: number,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/market/partner/cancel', { listingId });
};

export const buyPartnerMarketListing = (
  listingId: number,
  requestConfig?: AxiosRequestConfig,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/market/partner/buy', { listingId }, requestConfig);
};

export const getPartnerMarketTradeRecords = (params?: {
  page?: number;
  pageSize?: number;
}): Promise<MarketPartnerTradeRecordsResponse> => {
  return api.get('/market/partner-records', { params });
};

const SILENT_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;

export interface MarketPurchaseCaptchaVerifyResponse {
  success: boolean;
  message?: string;
  data?: {
    passExpiresAt: number;
  };
}

export const getMarketPurchaseCaptcha = (): Promise<CaptchaResponse> => {
  return api.get('/market/captcha', SILENT_REQUEST_CONFIG);
};

export const verifyMarketPurchaseCaptcha = (
  payload: UnifiedCaptchaPayload,
): Promise<MarketPurchaseCaptchaVerifyResponse> => {
  return api.post('/market/captcha/verify', payload, SILENT_REQUEST_CONFIG);
};


// ============================================
// 邮件相关接口
// ============================================

export interface MailAttachItem {
  item_def_id: string;
  item_name?: string;
  quality?: string;
  qty: number;
}

export interface MailDto {
  id: number;
  senderType: string;
  senderName: string;
  mailType: string;
  title: string;
  content: string;
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: MailAttachItem[];
  readAt: string | null;
  claimedAt: string | null;
  expireAt: string | null;
  createdAt: string;
}

export interface MailListResponse {
  success: boolean;
  message?: string;
  data?: {
    mails: MailDto[];
    total: number;
    unreadCount: number;
    unclaimedCount: number;
    page: number;
    pageSize: number;
  };
}

export interface MailUnreadResponse {
  success: boolean;
  data?: {
    unreadCount: number;
    unclaimedCount: number;
  };
}

export interface MailClaimResponse {
  success: boolean;
  message: string;
  rewards?: {
    silver?: number;
    spiritStones?: number;
    itemIds?: number[];
  };
}

export interface MailClaimAllResponse {
  success: boolean;
  message: string;
  claimedCount: number;
  skippedCount?: number;
  rewards?: {
    silver: number;
    spiritStones: number;
    itemCount: number;
  };
}

// 获取邮件列表
export const getMailList = (page: number = 1, pageSize: number = 50): Promise<MailListResponse> => {
  return api.get('/mail/list', { params: { page, pageSize } });
};

// 获取未读数量
export const getMailUnread = (): Promise<MailUnreadResponse> => {
  return api.get('/mail/unread');
};

// 阅读邮件
export const readMail = (mailId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/mail/read', { mailId });
};

// 领取附件
export const claimMailAttachments = (mailId: number): Promise<MailClaimResponse> => {
  return api.post('/mail/claim', { mailId });
};

// 一键领取所有附件
export const claimAllMailAttachments = (): Promise<MailClaimAllResponse> => {
  return api.post('/mail/claim-all');
};

// 删除邮件
export const deleteMail = (mailId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/mail/delete', { mailId });
};

// 一键删除所有邮件
export const deleteAllMails = (onlyRead: boolean = false): Promise<{ success: boolean; message: string; deletedCount: number }> => {
  return api.post('/mail/delete-all', { onlyRead });
};

// 标记全部已读
export const markAllMailsRead = (): Promise<{ success: boolean; message: string; readCount: number }> => {
  return api.post('/mail/read-all');
};
