#pragma once

#include <empathy.h>

#define EMPATHY_POOL_MAX_ELEMENTS		0x00FFFFFF
#define EMPATHY_POOL_MAX_GENERATIONS	0xFF
#define EMPATHY_POOL_HANDLE_NULL		0xFFFFFFFF

typedef uint32_t Empathy_PoolHandle;

typedef struct Empathy_Pool_t
{
	uint8_t *data;
	uint8_t *generations;
	uint32_t *nexts;
	uint32_t *prevs;
	uint32_t head;
	uint32_t tail;

	uint32_t element_size;
	uint32_t size;
	uint32_t capacity;

	uint32_t *masks;
	uint32_t *indices;
	uint32_t num_free_indices;
} Empathy_Pool;

Empathy_Result empathy_poolInitialize(Empathy_Pool *pool, uint32_t element_size, uint32_t capacity);
Empathy_Result empathy_poolShutdown(Empathy_Pool *pool);

Empathy_PoolHandle empathy_poolAddElement(Empathy_Pool *pool, const void *data);
Empathy_Result empathy_poolRemoveElement(Empathy_Pool *pool, Empathy_PoolHandle handle);
void *empathy_poolGetElement(const Empathy_Pool *pool, Empathy_PoolHandle handle);

void *empathy_poolGetElementByIndex(const Empathy_Pool *pool, uint32_t index);
uint32_t empathy_poolGetHeadIndex(const Empathy_Pool *pool);
uint32_t empathy_poolGetTailIndex(const Empathy_Pool *pool);
uint32_t empathy_poolGetNextIndex(const Empathy_Pool *pool, uint32_t index);
uint32_t empathy_poolGetPrevIndex(const Empathy_Pool *pool, uint32_t index);