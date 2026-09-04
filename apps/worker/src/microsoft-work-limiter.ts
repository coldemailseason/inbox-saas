export type ReleaseMicrosoftWorkPermit = () => void;

type Waiter = {
  organizationId: string;
  resolve: (release: ReleaseMicrosoftWorkPermit) => void;
};

export class MicrosoftWorkLimiter {
  #activeGlobal = 0;
  #activeByOrganization = new Map<string, number>();
  #waiters: Waiter[] = [];

  async acquire(organizationId: string): Promise<ReleaseMicrosoftWorkPermit> {
    if (this.#hasCapacity(organizationId)) {
      return this.#grant(organizationId);
    }

    return new Promise((resolve) => {
      this.#waiters.push({ organizationId, resolve });
    });
  }

  #hasCapacity(organizationId: string): boolean {
    return this.#activeGlobal < 5 && (this.#activeByOrganization.get(organizationId) ?? 0) < 3;
  }

  #grant(organizationId: string): ReleaseMicrosoftWorkPermit {
    this.#activeGlobal += 1;
    this.#activeByOrganization.set(
      organizationId,
      (this.#activeByOrganization.get(organizationId) ?? 0) + 1,
    );

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#activeGlobal -= 1;
      const activeForOrganization = (this.#activeByOrganization.get(organizationId) ?? 1) - 1;
      if (activeForOrganization === 0) {
        this.#activeByOrganization.delete(organizationId);
      } else {
        this.#activeByOrganization.set(organizationId, activeForOrganization);
      }
      this.#wakeWaiters();
    };
  }

  #wakeWaiters(): void {
    for (let index = 0; index < this.#waiters.length && this.#activeGlobal < 5;) {
      const waiter = this.#waiters[index];
      if (!waiter || !this.#hasCapacity(waiter.organizationId)) {
        index += 1;
        continue;
      }
      this.#waiters.splice(index, 1);
      waiter.resolve(this.#grant(waiter.organizationId));
    }
  }
}
