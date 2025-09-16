import * as React from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui';
import { useCalendar } from '@/hooks';
import { useAppStore } from '@/store';
import { CalendarItem } from '@/types';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Tv,
  Clock,
  CheckCircle,
  AlertCircle,
  Star,
  Globe,
  Monitor,
  MonitorX,
} from 'lucide-react';

export const CalendarPage = (): JSX.Element => {
  const { apiManager } = useAppStore();
  const [currentMonth, setCurrentMonth] = React.useState(new Date());
  const [selectedDate, setSelectedDate] = React.useState<Date | null>(null);

  // Calculate date range for the current month view
  const startOfMonth = new Date(
    currentMonth.getFullYear(),
    currentMonth.getMonth(),
    1
  );
  const endOfMonth = new Date(
    currentMonth.getFullYear(),
    currentMonth.getMonth() + 1,
    0
  );
  const startOfCalendar = new Date(startOfMonth);
  startOfCalendar.setDate(startOfCalendar.getDate() - startOfCalendar.getDay());
  const endOfCalendar = new Date(endOfMonth);
  endOfCalendar.setDate(endOfCalendar.getDate() + (6 - endOfCalendar.getDay()));

  const formatDateForAPI = (date: Date) => date.toISOString().split('T')[0];

  // Fetch calendar data for both services
  const {
    data: sonarrData = [],
    isLoading: sonarrLoading,
    error: sonarrError,
  } = useCalendar(
    'sonarr',
    formatDateForAPI(startOfCalendar),
    formatDateForAPI(endOfCalendar)
  );

  const {
    data: radarrData = [],
    isLoading: radarrLoading,
    error: radarrError,
  } = useCalendar(
    'radarr',
    formatDateForAPI(startOfCalendar),
    formatDateForAPI(endOfCalendar)
  );

  const isLoading = sonarrLoading || radarrLoading;
  const hasError = sonarrError || radarrError;

  const allItems = React.useMemo(() => {
    const combined: (CalendarItem & { service: 'sonarr' | 'radarr' })[] = [
      ...sonarrData.map((item: any) => {
        let seriesTitle = 'Unknown Series';

        if (item.series?.title) {
          seriesTitle = item.series.title;
        } else if (item.seriesTitle) {
          seriesTitle = item.seriesTitle;
        } else if (
          item.title &&
          !item.title.toLowerCase().includes('episode') &&
          !item.title.toLowerCase().includes('tba')
        ) {
          seriesTitle = item.title;
        }

        let episodeTitle = item.title || '';

        if (
          !episodeTitle ||
          episodeTitle === 'TBA' ||
          episodeTitle.trim() === ''
        ) {
          const episodeNum = item.episodeNumber || '?';
          episodeTitle = `Episode ${episodeNum}`;
        }

        const seasonNumber = item.seasonNumber || null;
        const episodeNumber = item.episodeNumber || null;

        return {
          ...item,
          service: 'sonarr' as const,
          type: 'episode' as const,
          seriesTitle,
          episodeTitle,
          displayTitle: episodeTitle,
          fullTitle: `${seriesTitle} - ${episodeTitle}`,
          seasonNumber,
          episodeNumber,
          time: item.airDateUtc
            ? new Date(item.airDateUtc).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })
            : null,
          network: item.series?.network || item.network || null,
          runtime: item.series?.runtime || item.runtime || null,
          overview: item.overview || item.series?.overview || null,
          genres: item.series?.genres || item.genres || null,
          ratings: item.series?.ratings || item.ratings || null,
        };
      }),
      ...radarrData.map((item: any) => {
        // Use the appropriate date fields for movies
        const releaseDate =
          item.physicalRelease || item.releaseDate || item.inCinemas;

        return {
          ...item,
          service: 'radarr' as const,
          type: 'movie' as const,
          seriesTitle: item.title, // For consistency with the UI
          episodeTitle: '', // Movies don't have episodes
          displayTitle: item.title,
          fullTitle: item.title,
          // Set the airDate fields that the grouping logic expects
          airDate: releaseDate,
          airDateUtc: releaseDate,
          time: releaseDate
            ? new Date(releaseDate).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })
            : null,
          network: item.studio || null,
          runtime: item.runtime || null,
          overview: item.overview || null,
          genres: item.genres || null,
          ratings: item.ratings || null,
        };
      }),
    ];

    const grouped = combined.reduce(
      (acc, item) => {
        const date = new Date(item.airDate || item.airDateUtc).toDateString();
        if (!acc[date]) acc[date] = [];
        acc[date].push(item);
        return acc;
      },
      {} as Record<
        string,
        (CalendarItem & {
          service: 'sonarr' | 'radarr';
          seriesTitle?: string;
          episodeTitle?: string;
          displayTitle?: string;
          fullTitle?: string;
          time?: string | null;
        })[]
      >
    );

    Object.keys(grouped).forEach(date => {
      grouped[date].sort((a, b) => {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      });
    });

    return grouped;
  }, [sonarrData, radarrData]);

  const goToPreviousMonth = () => {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
    );
  };

  const goToNextMonth = () => {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
    );
  };

  const goToToday = () => {
    setCurrentMonth(new Date());
  };

  const generateCalendarDays = () => {
    const days = [];
    const current = new Date(startOfCalendar);

    while (current <= endOfCalendar) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    return days;
  };

  const calendarDays = generateCalendarDays();
  const today = new Date();
  const isToday = (date: Date) => date.toDateString() === today.toDateString();
  const isCurrentMonth = (date: Date) =>
    date.getMonth() === currentMonth.getMonth();
  const getStatusColor = (item: CalendarItem & { service: string }) => {
    if (item.hasFile) return 'bg-green-500 text-white border-green-600';
    if (item.grabbed) return 'bg-blue-500 text-white border-blue-600';
    if (item.monitored) return 'bg-yellow-500 text-white border-yellow-600';
    return 'bg-gray-400 text-white border-gray-500';
  };

  const getStatusIcon = (
    item: CalendarItem & { service: string }
  ): JSX.Element => {
    if (item.hasFile) return <CheckCircle className="h-3 w-3" />;
    if (item.grabbed) return <Clock className="h-3 w-3" />;
    if (item.monitored) return <Monitor className="h-3 w-3" />;
    return <MonitorX className="h-3 w-3" />;
  };

  const getStatusText = (item: CalendarItem & { service: string }) => {
    if (item.hasFile) return 'Downloaded';
    if (item.grabbed) return 'Grabbed';
    if (item.monitored) return 'Monitored';
    return 'Unmonitored';
  };

  const getRatingColor = (rating: number) => {
    if (rating >= 8) return 'text-green-600';
    if (rating >= 6) return 'text-yellow-600';
    return 'text-red-600';
  };

  const canShowCalendar =
    apiManager?.isConfigured('sonarr') || apiManager?.isConfigured('radarr');

  if (!canShowCalendar) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Calendar</h1>
          <p className="text-muted-foreground mt-2">
            Upcoming releases and air dates
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <AlertCircle className="h-8 w-8 text-yellow-600" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Configuration Required
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Please configure Sonarr and/or Radarr to view upcoming
                  releases and air dates.
                </p>
                <button
                  onClick={() => (window.location.href = '/settings')}
                  className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Configure Services
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Calendar</h1>
        <p className="text-muted-foreground mt-2">
          Upcoming TV episodes and movie releases with detailed information
        </p>
      </div>

      {/* Calendar Controls */}
      <Card>
        <CardContent>
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center space-x-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {currentMonth.toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric',
                })}
              </h2>
              <div className="flex items-center space-x-2">
                <button
                  onClick={goToPreviousMonth}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors border"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  onClick={goToToday}
                  className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
                >
                  Today
                </button>
                <button
                  onClick={goToNextMonth}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors border"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            </div>

            {isLoading && (
              <div className="flex items-center space-x-2 text-muted-foreground">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
                <span className="text-sm font-medium">
                  Loading calendar data...
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {/* Days of week header */}
          <div className="grid grid-cols-7 border-b">
            {[
              'Sunday',
              'Monday',
              'Tuesday',
              'Wednesday',
              'Thursday',
              'Friday',
              'Saturday',
            ].map(day => (
              <div
                key={day}
                className="bg-gray-50 dark:bg-gray-800 p-4 text-center border-r last:border-r-0"
              >
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  {day}
                </span>
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {calendarDays.map((date, index) => {
              const dateString = date.toDateString();
              const dayItems = allItems[dateString] || [];
              const isPreviousOrNextMonth = !isCurrentMonth(date);

              return (
                <div
                  key={index}
                  className={[
                    'min-h-[140px] p-2 border-r border-b last:border-r-0 cursor-pointer transition-all duration-200 hover:bg-gray-50 dark:hover:bg-gray-700',
                    isPreviousOrNextMonth
                      ? 'opacity-40 bg-gray-50 dark:bg-gray-900'
                      : 'bg-white dark:bg-gray-800',
                    isToday(date)
                      ? 'ring-2 ring-blue-500 ring-inset bg-blue-50 dark:bg-blue-900/20'
                      : '',
                    selectedDate?.toDateString() === dateString
                      ? 'bg-blue-100 dark:bg-blue-900/30'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() =>
                    setSelectedDate(
                      selectedDate?.toDateString() === dateString ? null : date
                    )
                  }
                >
                  <div className="flex justify-between items-start mb-2">
                    <span
                      className={[
                        'text-sm font-semibold',
                        isToday(date)
                          ? 'text-blue-700 bg-blue-200 px-2 py-1 rounded-full'
                          : 'text-gray-900 dark:text-gray-100',
                      ].join(' ')}
                    >
                      {date.getDate()}
                    </span>
                    {dayItems.length > 0 && (
                      <span className="text-xs bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center font-bold shadow-sm">
                        {dayItems.length}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1">
                    {dayItems.slice(0, 3).map((item, itemIndex) => (
                      <div
                        key={itemIndex}
                        className={[
                          'text-xs p-2 rounded-md border-l-4 shadow-sm transition-all duration-200 hover:shadow-md',
                          getStatusColor(item),
                        ].join(' ')}
                        title={`${item.fullTitle} ${item.time ? `at ${item.time}` : ''}`}
                      >
                        <div className="flex items-center space-x-1 mb-1">
                          {item.service === 'sonarr' ? (
                            <Tv className="h-3 w-3 flex-shrink-0" />
                          ) : (
                            <Film className="h-3 w-3 flex-shrink-0" />
                          )}
                          {getStatusIcon(item)}
                          {item.time && (
                            <Clock className="h-3 w-3 flex-shrink-0" />
                          )}
                        </div>
                        <div
                          className="font-medium truncate leading-tight"
                          title={(item as any).seriesTitle}
                        >
                          {item.service === 'sonarr'
                            ? (item as any).seriesTitle || 'Unknown Series'
                            : item.title}
                        </div>
                        {item.service === 'sonarr' && (
                          <div
                            className="truncate opacity-90 text-xs"
                            title={(item as any).episodeTitle}
                          >
                            {(item as any).episodeTitle}
                          </div>
                        )}
                        <div className="flex items-center justify-between mt-1">
                          {item.time && (
                            <span className="text-xs opacity-90 font-medium">
                              {item.time}
                            </span>
                          )}
                          {item.service === 'sonarr' &&
                            item.seasonNumber &&
                            item.episodeNumber && (
                              <span className="text-xs opacity-90 font-mono">
                                S{String(item.seasonNumber).padStart(2, '0')}E
                                {String(item.episodeNumber).padStart(2, '0')}
                              </span>
                            )}
                        </div>
                      </div>
                    ))}
                    {dayItems.length > 3 && (
                      <div className="text-xs text-center py-1 bg-gray-200 dark:bg-gray-700 rounded-md font-medium">
                        +{dayItems.length - 3} more items
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Selected Date Details */}
      {selectedDate && allItems[selectedDate.toDateString()] && (
        <Card className="border-2 border-blue-200 dark:border-blue-800">
          <CardHeader
            title={selectedDate.toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
            subtitle={`${allItems[selectedDate.toDateString()].length} scheduled release${allItems[selectedDate.toDateString()].length !== 1 ? 's' : ''}`}
          />
          <CardContent>
            <div className="grid gap-4">
              {allItems[selectedDate.toDateString()].map((item, index) => (
                <div
                  key={index}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start space-x-4">
                    <div className="flex-shrink-0 p-2 rounded-lg bg-gray-100 dark:bg-gray-800">
                      {item.service === 'sonarr' ? (
                        <Tv className="h-6 w-6 text-blue-600" />
                      ) : (
                        <Film className="h-6 w-6 text-purple-600" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                            {item.service === 'sonarr'
                              ? (item as any).seriesTitle || 'Unknown Series'
                              : item.title}
                          </h3>
                          {item.service === 'sonarr' && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                              {(item as any).episodeTitle}
                            </p>
                          )}
                        </div>
                        <div
                          className={`px-3 py-1 rounded-full text-xs font-medium border ${getStatusColor(item)}`}
                        >
                          <div className="flex items-center space-x-1">
                            {getStatusIcon(item)}
                            <span>{getStatusText(item)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600 dark:text-gray-400 mb-3">
                        <div className="flex items-center space-x-1">
                          <span className="font-medium">
                            {item.service === 'sonarr' ? 'TV Show' : 'Movie'}
                          </span>
                        </div>

                        {item.time && (
                          <div className="flex items-center space-x-1">
                            <Clock className="h-4 w-4" />
                            <span className="font-medium">{item.time}</span>
                          </div>
                        )}

                        {item.service === 'sonarr' &&
                          item.seasonNumber &&
                          item.episodeNumber && (
                            <div className="flex items-center space-x-1">
                              <span className="font-mono font-medium bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                                S{String(item.seasonNumber).padStart(2, '0')}E
                                {String(item.episodeNumber).padStart(2, '0')}
                              </span>
                            </div>
                          )}

                        {item.runtime && item.runtime > 0 && (
                          <div className="flex items-center space-x-1">
                            <span>{item.runtime} min</span>
                          </div>
                        )}

                        {item.network && (
                          <div className="flex items-center space-x-1">
                            <Globe className="h-4 w-4" />
                            <span>{item.network}</span>
                          </div>
                        )}

                        {item.ratings?.imdb?.value && (
                          <div className="flex items-center space-x-1">
                            <Star className="h-4 w-4 text-yellow-500" />
                            <span
                              className={getRatingColor(
                                item.ratings.imdb.value
                              )}
                            >
                              {item.ratings.imdb.value.toFixed(1)}
                            </span>
                          </div>
                        )}
                      </div>

                      {item.overview &&
                        item.overview.trim() &&
                        item.overview !== 'TBA' && (
                          <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                            {item.overview.length > 250
                              ? `${item.overview.substring(0, 250)}...`
                              : item.overview}
                          </p>
                        )}

                      {item.genres && item.genres.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-3">
                          {item.genres.slice(0, 4).map((genre, idx) => (
                            <span
                              key={idx}
                              className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 px-2 py-1 rounded-full"
                            >
                              {genre}
                            </span>
                          ))}
                          {item.genres.length > 4 && (
                            <span className="text-xs text-gray-500">
                              +{item.genres.length - 4} more
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error State */}
      {hasError && (
        <Card className="border-red-200 dark:border-red-800">
          <CardContent>
            <div className="flex items-center space-x-4 p-6">
              <AlertCircle className="h-8 w-8 text-red-600" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Error Loading Calendar Data
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  There was an error loading calendar data from your services.
                  Please check your configuration and try again.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
