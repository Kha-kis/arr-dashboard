"use client";

import { useEffect, useState } from "react";
import type { LibraryService } from "@arr/shared";

/**
 * Status filter options for library items
 */
const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "monitored", label: "Monitored" },
  { value: "unmonitored", label: "Not monitored" },
] as const;

/**
 * File filter options for library items
 */
const FILE_FILTERS = [
  { value: "all", label: "All files" },
  { value: "has-file", label: "Has file" },
  { value: "missing", label: "Missing file" },
] as const;

export type StatusFilterValue = (typeof STATUS_FILTERS)[number]["value"];
export type FileFilterValue = (typeof FILE_FILTERS)[number]["value"];

export interface LibraryFilters {
  serviceFilter: "all" | LibraryService;
  setServiceFilter: (value: "all" | LibraryService) => void;
  instanceFilter: string;
  setInstanceFilter: (value: string) => void;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  statusFilter: StatusFilterValue;
  setStatusFilter: (value: StatusFilterValue) => void;
  fileFilter: FileFilterValue;
  setFileFilter: (value: FileFilterValue) => void;
}

/**
 * Custom hook for managing library filter state
 *
 * Manages all filter-related state for the library view including:
 * - Service filter (all/radarr/sonarr)
 * - Instance filter
 * - Search term
 * - Status filter (monitored/unmonitored)
 * - File filter (has-file/missing)
 *
 * Automatically resets the instance filter when the service filter changes.
 *
 * @returns Object containing all filter state values and their setters
 */
export function useLibraryFilters(): LibraryFilters {
  const [serviceFilter, setServiceFilter] = useState<"all" | LibraryService>(
    "all",
  );
  const [instanceFilter, setInstanceFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
  const [fileFilter, setFileFilter] = useState<FileFilterValue>("all");

  // Reset instance filter when service filter changes
  useEffect(() => {
    setInstanceFilter("all");
  }, [serviceFilter]);

  return {
    serviceFilter,
    setServiceFilter,
    instanceFilter,
    setInstanceFilter,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    fileFilter,
    setFileFilter,
  };
}
