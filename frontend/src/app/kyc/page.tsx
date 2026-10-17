"use client";

import { useState, useEffect } from "react";
import { api } from "../../lib/api";

type KycStatusResponse = { status: string };

async function fetchKycStatus(): Promise<KycStatusResponse> {
  return await api.get<KycStatusResponse>("/api/v1/sep8/kyc/status");
}

async function submitKycData(data: Record<string, string>) {
  return await api.post<KycStatusResponse>("/api/v1/sep8/kyc", data);
}

export default function KycPage() {
  const [status, setStatus] = useState<string>("LOADING");
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    documentId: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function loadStatus() {
      try {
        const data = await fetchKycStatus();
        setStatus(data.status);
      } catch {
        setStatus("UNVERIFIED");
      }
    }
    void loadStatus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await submitKycData(formData);
      setStatus(data.status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to submit KYC";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (status === "LOADING") return <div className="p-8 text-center text-white">Loading KYC status...</div>;
  if (status === "APPROVED") return <div className="p-8 text-center text-green-500 font-bold">Your identity has been verified. You may now withdraw regulated assets.</div>;
  if (status === "PENDING") return <div className="p-8 text-center text-yellow-500 font-bold">Your KYC application is currently under review.</div>;
  
  return (
    <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded-lg shadow-md text-gray-800">
      <h2 className="text-2xl font-bold mb-4">Identity Verification</h2>
      <p className="mb-4 text-sm text-gray-600">Please provide your details to comply with SEP-8 regulated assets withdrawals.</p>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">First Name</label>
          <input 
            type="text" 
            required 
            className="w-full mt-1 p-2 border rounded"
            value={formData.firstName}
            onChange={(e) => setFormData({...formData, firstName: e.target.value})}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Last Name</label>
          <input 
            type="text" 
            required 
            className="w-full mt-1 p-2 border rounded"
            value={formData.lastName}
            onChange={(e) => setFormData({...formData, lastName: e.target.value})}
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Document ID (Passport / ID)</label>
          <input 
            type="text" 
            required 
            className="w-full mt-1 p-2 border rounded"
            value={formData.documentId}
            onChange={(e) => setFormData({...formData, documentId: e.target.value})}
          />
        </div>
        <button 
          type="submit" 
          disabled={loading}
          className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Submitting..." : "Submit Verification"}
        </button>
      </form>
    </div>
  );
}
