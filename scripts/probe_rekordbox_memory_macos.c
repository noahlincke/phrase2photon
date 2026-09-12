#include <ctype.h>
#include <inttypes.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>

typedef struct {
  size_t offsets[8];
  size_t offset_count;
  size_t final_offset;
} pointer_chain_t;

typedef struct {
  mach_port_t task;
  mach_vm_address_t base;
} process_ctx_t;

typedef struct {
  uint64_t all_image_info_addr;
  uint64_t all_image_info_size;
  int32_t all_image_info_format;
} task_dyld_info_data_t_local;

static const uint32_t TASK_DYLD_INFO_LOCAL = 17;
static const uint32_t TASK_DYLD_INFO_COUNT_LOCAL =
    sizeof(task_dyld_info_data_t_local) / sizeof(natural_t);

static const pointer_chain_t MASTER_DECK = {{0x04DCFD18, 0x20, 0x278}, 3, 0x124};
static const pointer_chain_t BPM_PTRS[4] = {
    {{0x04D8AA18, 0x0, 0x2C8}, 3, 0x188},
    {{0x04D8AA18, 0x8, 0x2C8}, 3, 0x188},
    {{0x04D8AA18, 0x10, 0x2C8}, 3, 0x188},
    {{0x04D8AA18, 0x18, 0x2C8}, 3, 0x188},
};
static const pointer_chain_t SAMPLE_PTRS[4] = {
    {{0x04D8AA18, 0x0, 0x2C8}, 3, 0x120},
    {{0x04D8AA18, 0x8, 0x2C8}, 3, 0x120},
    {{0x04D8AA18, 0x10, 0x2C8}, 3, 0x120},
    {{0x04D8AA18, 0x18, 0x2C8}, 3, 0x120},
};
static const pointer_chain_t TRACK_PTRS[4] = {
    {{0x04D8AA18, 0x0, 0x270, 0x38, 0x80, 0x28, 0xF0}, 7, 0x4},
    {{0x04D8AA18, 0x8, 0x270, 0x38, 0x68, 0x28, 0xF0}, 7, 0x4},
    {{0x04D8AA18, 0x10, 0x270, 0x38, 0x48, 0x28, 0xF0}, 7, 0x4},
    {{0x04D8AA18, 0x18, 0x270, 0x38, 0x48, 0x28, 0xF0}, 7, 0x4},
};
static const pointer_chain_t ANLZ_PTRS[4] = {
    {{0x04DD0708, 0x8, 0x3F0}, 3, 0x0},
    {{0x04DD0708, 0x10, 0x3F0}, 3, 0x0},
    {{0x04DD0708, 0x18, 0x3F0}, 3, 0x0},
    {{0x04DD0708, 0x20, 0x3F0}, 3, 0x0},
};

static int read_bytes(mach_port_t task, mach_vm_address_t address, void *out, mach_vm_size_t size) {
  mach_vm_size_t read_size = 0;
  kern_return_t kr =
      mach_vm_read_overwrite(task, address, size, (mach_vm_address_t)out, &read_size);
  return kr == KERN_SUCCESS && read_size == size;
}

static int find_pid_by_suffix(const char *suffix, pid_t *pid_out) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  size_t size = 0;
  if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) return 0;
  struct kinfo_proc *procs = malloc(size);
  if (!procs) return 0;
  if (sysctl(mib, 4, procs, &size, NULL, 0) != 0) {
    free(procs);
    return 0;
  }
  size_t count = size / sizeof(struct kinfo_proc);
  size_t suffix_len = strlen(suffix);
  for (size_t i = 0; i < count; ++i) {
    const char *name = procs[i].kp_proc.p_comm;
    size_t name_len = strlen(name);
    if (name_len >= suffix_len && strcmp(name + name_len - suffix_len, suffix) == 0) {
      *pid_out = procs[i].kp_proc.p_pid;
      free(procs);
      return 1;
    }
  }
  free(procs);
  return 0;
}

static int init_process(process_ctx_t *ctx, pid_t pid) {
  mach_port_t task = MACH_PORT_NULL;
  kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
  if (kr != KERN_SUCCESS) {
    fprintf(stderr, "task_for_pid failed for pid %d: %s\n", pid, mach_error_string(kr));
    return 0;
  }

  task_dyld_info_data_t_local dyld_info = {0};
  mach_msg_type_number_t count = TASK_DYLD_INFO_COUNT_LOCAL;
  kr = task_info(task, TASK_DYLD_INFO_LOCAL, (task_info_t)&dyld_info, &count);
  if (kr != KERN_SUCCESS) {
    fprintf(stderr, "task_info(TASK_DYLD_INFO) failed: %s\n", mach_error_string(kr));
    return 0;
  }

  unsigned char header[16] = {0};
  if (!read_bytes(task, dyld_info.all_image_info_addr, header, sizeof(header))) {
    fprintf(stderr, "failed to read dyld_all_image_infos\n");
    return 0;
  }
  uint64_t info_array_ptr = 0;
  memcpy(&info_array_ptr, header + 8, sizeof(info_array_ptr));

  uint64_t base = 0;
  if (!read_bytes(task, info_array_ptr, &base, sizeof(base))) {
    fprintf(stderr, "failed to read first dyld image entry\n");
    return 0;
  }

  ctx->task = task;
  ctx->base = base;
  return 1;
}

static int resolve_pointer_chain(const process_ctx_t *ctx, const pointer_chain_t *chain,
                                 mach_vm_address_t *resolved) {
  mach_vm_address_t address = ctx->base;
  for (size_t i = 0; i < chain->offset_count; ++i) {
    mach_vm_address_t next = 0;
    if (!read_bytes(ctx->task, address + chain->offsets[i], &next, sizeof(next))) return 0;
    address = next;
    if (address == 0) return 0;
  }
  *resolved = address + chain->final_offset;
  return 1;
}

static void print_sanitized_string(const char *label, const char *value) {
  char out[160];
  size_t j = 0;
  for (size_t i = 0; value[i] != '\0' && j + 1 < sizeof(out); ++i) {
    unsigned char c = (unsigned char)value[i];
    if (isprint(c)) out[j++] = (char)c;
  }
  out[j] = '\0';
  printf("%s%s\n", label, out);
}

static void print_hex_bytes(const char *label, const unsigned char *buf, size_t size) {
  printf("%s", label);
  for (size_t i = 0; i < size; ++i) printf("%02x", buf[i]);
  printf("\n");
}

static void print_track_fields(const char *raw) {
  const char *title = strstr(raw, "Title:");
  const char *artist = strstr(raw, "Artist:");
  const char *album = strstr(raw, "Album:");
  if (title) {
    title += 6;
    while (*title == ' ') title++;
    char buf[160];
    size_t n = 0;
    while (title[n] && strncmp(title + n, "Artist:", 7) != 0 && n + 1 < sizeof(buf)) {
      buf[n] = title[n];
      n++;
    }
    buf[n] = '\0';
    print_sanitized_string("  title=", buf);
  }
  if (artist) {
    artist += 7;
    while (*artist == ' ') artist++;
    char buf[160];
    size_t n = 0;
    while (artist[n] && strncmp(artist + n, "Album:", 6) != 0 && n + 1 < sizeof(buf)) {
      buf[n] = artist[n];
      n++;
    }
    buf[n] = '\0';
    print_sanitized_string("  artist=", buf);
  }
  if (album) {
    album += 6;
    while (*album == ' ') album++;
    print_sanitized_string("  album=", album);
  }
}

int main(int argc, char **argv) {
  pid_t pid = 0;
  if (argc >= 2) {
    pid = (pid_t)atoi(argv[1]);
  } else if (!find_pid_by_suffix("rekordbox", &pid)) {
    fprintf(stderr, "Could not find a running rekordbox process.\n");
    return 1;
  }

  process_ctx_t ctx = {0};
  if (!init_process(&ctx, pid)) return 1;

  printf("pid=%d\n", pid);
  printf("base=0x%llx\n", (unsigned long long)ctx.base);

  mach_vm_address_t addr = 0;
  uint8_t master = 255;
  if (resolve_pointer_chain(&ctx, &MASTER_DECK, &addr) &&
      read_bytes(ctx.task, addr, &master, sizeof(master))) {
    printf("master_deck=%u\n", (unsigned)master);
    unsigned char master_bytes[16] = {0};
    if (read_bytes(ctx.task, addr, master_bytes, sizeof(master_bytes))) {
      print_hex_bytes("master_bytes=", master_bytes, sizeof(master_bytes));
    }
  } else {
    printf("master_deck=unreadable\n");
  }

  for (int i = 0; i < 4; ++i) {
    float bpm = 0.0f;
    int64_t samples = 0;
    char track[256];
    char anlz[512];
    memset(track, 0, sizeof(track));
    memset(anlz, 0, sizeof(anlz));

    printf("deck_%d:\n", i + 1);

    if (resolve_pointer_chain(&ctx, &BPM_PTRS[i], &addr) &&
        read_bytes(ctx.task, addr, &bpm, sizeof(bpm))) {
      printf("  bpm=%.3f\n", bpm);
    } else {
      printf("  bpm=unreadable\n");
    }

    if (resolve_pointer_chain(&ctx, &SAMPLE_PTRS[i], &addr) &&
        read_bytes(ctx.task, addr, &samples, sizeof(samples))) {
      printf("  sample_position=%" PRId64 "\n", samples);
      printf("  seconds=%.3f\n", (double)samples / 44100.0);
    } else {
      printf("  sample_position=unreadable\n");
    }

    if (resolve_pointer_chain(&ctx, &TRACK_PTRS[i], &addr) &&
        read_bytes(ctx.task, addr, &track, sizeof(track) - 1)) {
      print_sanitized_string("  track_info=", track);
      print_track_fields(track);
    } else {
      printf("  track_info=unreadable\n");
    }

    if (resolve_pointer_chain(&ctx, &ANLZ_PTRS[i], &addr) &&
        read_bytes(ctx.task, addr, &anlz, sizeof(anlz) - 1)) {
      print_sanitized_string("  anlz_path=", anlz);
    } else {
      printf("  anlz_path=unreadable\n");
    }
  }

  return 0;
}
