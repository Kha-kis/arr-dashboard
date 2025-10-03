'use client';

import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  Input,
  Select,
  SelectOption,
  Alert,
  AlertTitle,
  AlertDescription,
  EmptyState,
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonAvatar,
  toast,
} from '../../src/components/ui';
import { Search, Inbox, Heart, AlertCircle } from 'lucide-react';
import { useState } from 'react';

/**
 * UI Component Kitchen Sink
 *
 * Showcases all available UI components in the design system.
 * Useful for:
 * - Design review and visual QA
 * - Component documentation
 * - Accessibility testing
 * - Responsive behavior verification
 */

export default function UIDemoPage() {
  const [showSkeleton, setShowSkeleton] = useState(false);

  return (
    <div className="container mx-auto max-w-7xl space-y-12 p-6">
      {/* Page Header */}
      <div className="space-y-2">
        <h1 className="text-4xl font-bold gradient-text">UI Component Library</h1>
        <p className="text-lg text-fg-muted">
          Complete design system showcase with all components and variants
        </p>
      </div>

      {/* Buttons Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Buttons</h2>
          <p className="text-sm text-fg-muted">Interactive button variants with different states</p>
        </div>

        <div className="space-y-6">
          {/* Button Variants */}
          <Card>
            <CardHeader>
              <CardTitle>Button Variants</CardTitle>
              <CardDescription>Primary, secondary, ghost, danger, and gradient styles</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                <Button variant="primary">Primary Button</Button>
                <Button variant="gradient">Gradient Button</Button>
                <Button variant="secondary">Secondary Button</Button>
                <Button variant="ghost">Ghost Button</Button>
                <Button variant="danger">Danger Button</Button>
                <Button variant="primary" disabled>Disabled Button</Button>
              </div>
            </CardContent>
          </Card>

          {/* Button Sizes */}
          <Card>
            <CardHeader>
              <CardTitle>Button Sizes</CardTitle>
              <CardDescription>Small, medium, and large size variants</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small Button</Button>
                <Button size="md">Medium Button</Button>
                <Button size="lg">Large Button</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Badges Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Badges</h2>
          <p className="text-sm text-fg-muted">Status indicators and tags</p>
        </div>

        <div className="space-y-6">
          {/* Badge Variants */}
          <Card>
            <CardHeader>
              <CardTitle>Badge Variants</CardTitle>
              <CardDescription>Semantic color variants for different states</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                <Badge variant="default">Default</Badge>
                <Badge variant="success">Success</Badge>
                <Badge variant="warning">Warning</Badge>
                <Badge variant="danger">Danger</Badge>
                <Badge variant="info">Info</Badge>
              </div>
            </CardContent>
          </Card>

          {/* Badge Sizes */}
          <Card>
            <CardHeader>
              <CardTitle>Badge Sizes</CardTitle>
              <CardDescription>Different badge sizes for various use cases</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-3">
                <Badge size="sm">Small</Badge>
                <Badge size="md">Medium</Badge>
                <Badge size="lg">Large</Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Form Inputs Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Form Inputs</h2>
          <p className="text-sm text-fg-muted">Input fields and selection controls</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Text Input</CardTitle>
            <CardDescription>Standard text input with placeholder</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input placeholder="Enter your name..." />
            <Input placeholder="Email address..." type="email" />
            <Input placeholder="Disabled input" disabled />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Select Dropdown</CardTitle>
            <CardDescription>Dropdown selection component</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select>
              <SelectOption value="">Select an option...</SelectOption>
              <SelectOption value="option1">Option 1</SelectOption>
              <SelectOption value="option2">Option 2</SelectOption>
              <SelectOption value="option3">Option 3</SelectOption>
            </Select>
            <Select disabled>
              <SelectOption value="">Disabled select</SelectOption>
            </Select>
          </CardContent>
        </Card>
      </section>

      {/* Alerts Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Alerts</h2>
          <p className="text-sm text-fg-muted">Contextual feedback messages</p>
        </div>

        <Card>
          <CardContent className="space-y-4">
            <Alert variant="info">
              <AlertTitle>Information</AlertTitle>
              <AlertDescription>
                This is an informational alert with helpful context for users.
              </AlertDescription>
            </Alert>

            <Alert variant="success">
              <AlertTitle>Success!</AlertTitle>
              <AlertDescription>
                Your changes have been saved successfully.
              </AlertDescription>
            </Alert>

            <Alert variant="warning">
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>
                Please review the following items before continuing.
              </AlertDescription>
            </Alert>

            <Alert variant="danger">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>
                An error occurred while processing your request.
              </AlertDescription>
            </Alert>

            <Alert variant="info" dismissible onDismiss={() => console.log('Dismissed')}>
              <AlertTitle>Dismissible Alert</AlertTitle>
              <AlertDescription>
                This alert can be dismissed by clicking the X button.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </section>

      {/* Toast Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Toast Notifications</h2>
          <p className="text-sm text-fg-muted">Temporary notification messages</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Toast Variants</CardTitle>
            <CardDescription>Click buttons to trigger different toast types</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => toast.success('Success toast notification!')}>
                Success Toast
              </Button>
              <Button onClick={() => toast.error('Error toast notification!')}>
                Error Toast
              </Button>
              <Button onClick={() => toast.info('Info toast notification!')}>
                Info Toast
              </Button>
              <Button onClick={() => toast.warning('Warning toast notification!')}>
                Warning Toast
              </Button>
              <Button onClick={() => toast('Default toast notification')}>
                Default Toast
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Empty States Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Empty States</h2>
          <p className="text-sm text-fg-muted">Friendly empty state displays</p>
        </div>

        <Card>
          <CardContent>
            <EmptyState
              icon={Inbox}
              title="No items found"
              description="Get started by creating your first item."
              action={{
                label: 'Create Item',
                onClick: () => toast.info('Create action clicked'),
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <EmptyState
              icon={Search}
              title="No search results"
              description="Try adjusting your search terms or filters."
            />
          </CardContent>
        </Card>
      </section>

      {/* Loading States Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Loading States</h2>
          <p className="text-sm text-fg-muted">Skeleton placeholders during data loading</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Skeleton Components</CardTitle>
            <CardDescription>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowSkeleton(!showSkeleton)}
              >
                {showSkeleton ? 'Hide' : 'Show'} Skeletons
              </Button>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {showSkeleton ? (
              <>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-fg-muted">Basic Skeleton</p>
                  <Skeleton className="h-10 w-full" />
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-fg-muted">Text Skeleton</p>
                  <SkeletonText lines={4} />
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-fg-muted">Card Skeleton</p>
                  <SkeletonCard />
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-fg-muted">Avatar Skeletons</p>
                  <div className="flex gap-4">
                    <SkeletonAvatar size="sm" />
                    <SkeletonAvatar size="md" />
                    <SkeletonAvatar size="lg" />
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-fg-muted">
                Click the button above to view skeleton loading states
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Cards Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Cards</h2>
          <p className="text-sm text-fg-muted">Container components with glassmorphism</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Basic Card</CardTitle>
              <CardDescription>Simple card with title and description</CardDescription>
            </CardHeader>
            <CardContent>
              This is a basic card component with glassmorphism effects and hover animations.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <div className="flex items-center gap-2">
                  <Heart className="h-5 w-5 text-danger" />
                  Card with Icon
                </div>
              </CardTitle>
              <CardDescription>Enhanced with icon in title</CardDescription>
            </CardHeader>
            <CardContent>
              Cards can include icons and other elements in the header for visual interest.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Interactive Card</CardTitle>
              <CardDescription>Card with action button</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm">Cards can contain interactive elements like buttons.</p>
              <Button size="sm" variant="primary" className="w-full">
                Take Action
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Typography Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Typography</h2>
          <p className="text-sm text-fg-muted">Text styles and hierarchy</p>
        </div>

        <Card>
          <CardContent className="space-y-4">
            <h1 className="text-4xl font-bold text-fg">Heading 1 - 4xl</h1>
            <h2 className="text-3xl font-semibold text-fg">Heading 2 - 3xl</h2>
            <h3 className="text-2xl font-semibold text-fg">Heading 3 - 2xl</h3>
            <h4 className="text-xl font-semibold text-fg">Heading 4 - xl</h4>
            <h5 className="text-lg font-medium text-fg">Heading 5 - lg</h5>
            <h6 className="text-base font-medium text-fg">Heading 6 - base</h6>
            <p className="text-base text-fg-subtle">Body text - base size with subtle color</p>
            <p className="text-sm text-fg-muted">Small text - sm size with muted color</p>
            <p className="text-xs text-fg-muted">Extra small text - xs size</p>
            <p className="text-lg gradient-text">Gradient text effect</p>
          </CardContent>
        </Card>
      </section>

      {/* Color Palette Section */}
      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold text-fg mb-2">Color Palette</h2>
          <p className="text-sm text-fg-muted">Design system color tokens</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Semantic Colors</CardTitle>
            <CardDescription>Contextual color variants</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-primary shadow-primary" />
                <p className="text-xs font-medium">Primary</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-accent shadow-accent" />
                <p className="text-xs font-medium">Accent</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-success" />
                <p className="text-xs font-medium">Success</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-warning" />
                <p className="text-xs font-medium">Warning</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-danger" />
                <p className="text-xs font-medium">Danger</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-info" />
                <p className="text-xs font-medium">Info</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-bg border border-border" />
                <p className="text-xs font-medium">Background</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-bg-subtle border border-border" />
                <p className="text-xs font-medium">Subtle</p>
              </div>
              <div className="space-y-2">
                <div className="h-16 rounded-lg bg-bg-muted border border-border" />
                <p className="text-xs font-medium">Muted</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Footer */}
      <div className="pt-12 pb-6 text-center text-sm text-fg-muted">
        <p>UI Component Library - Phase 1 Implementation</p>
        <p className="mt-1">Built with Tailwind CSS design tokens and React components</p>
      </div>
    </div>
  );
}
